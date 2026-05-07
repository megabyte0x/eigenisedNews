import type {
  SynthesizeRequest,
  Manifest,
  ModelRun,
  Claim,
  InputRecord,
  RawModelOutput,
  StructuredClaim,
  NewsResearchRequest,
  NewsResearchResponse,
  NewsResearchAgentRun,
} from "./types";
import { POLICY, providerModelKey, type ModelSpec } from "./lib/policy";
import { sha256OfCanonical } from "./lib/canonicalHash";
import { sha256Hex } from "./lib/hash";
import type { FetchUrlResult } from "./fetchers/sourceFetcher";
import { hashText } from "./fetchers/sourceFetcher";
import { renderPromptForModel } from "./fanout/structuredPrompt";
import { parseStructuredOutput } from "./fanout/llmProxy";
import { consensus, type ConsensusInput } from "./merger/consensus";
import { buildManifest } from "./manifest/build";
import type { ManifestSigner } from "./manifest/sign";
import type { Sha256 } from "./lib/hash";

export type RunSynthesisDeps = {
  fetchUrl: (url: string) => Promise<FetchUrlResult>;
  callModel: (args: { provider: string; model: string; prompt: string }) => Promise<{ rawOutput: string; latencyMs: number }>;
  now: () => string;
  deployment: Manifest["deployment"];
  sign: ManifestSigner;
  onStructuredOutputDebugInfo?: (info: StructuredOutputDebugInfo) => void;
};

export type { RawModelOutput } from "./types";

export type StructuredOutputDebugInfo = {
  code: "structured_output_not_pure_json";
  provider: string;
  model: string;
  promptHash: Sha256;
  rawOutputSha256: ReturnType<typeof sha256Hex>;
  rawOutputByteLength: number;
  rawOutput: string;
};

export type RunSynthesisResult =
  | { status: "validation_error"; error: string; manifest: null; signature: null; raw: [] }
  | { status: "threshold_not_met"; manifest: Manifest; signature: `0x${string}`; raw: RawModelOutput[] }
  | { status: "ok"; manifest: Manifest; signature: `0x${string}`; raw: RawModelOutput[] };

export type RunArticleResearchResult =
  | { status: "validation_error"; error: "article_url_required" | "article_url_invalid" }
  | { status: "fetch_error"; error: string; article: NewsResearchResponse["article"] }
  | ({ status: "ok" } & NewsResearchResponse);

type ValidationError = "topic_required" | "topic_too_long" | "no_inputs" | "too_many_inputs";

function validate(req: SynthesizeRequest): ValidationError | null {
  if (typeof req.topic !== "string" || req.topic.length === 0) return "topic_required";
  if (req.topic.length > POLICY.MAX_TOPIC_LEN) return "topic_too_long";
  const total = (req.urls?.length ?? 0) + (req.sources?.length ?? 0);
  if (total === 0) return "no_inputs";
  if (total > POLICY.MAX_INPUTS) return "too_many_inputs";
  return null;
}

type FanoutOk = { ok: true; spec: ModelSpec; promptHash: Sha256; rawOutput: string; rawOutputSha256: ReturnType<typeof sha256Hex>; parsedClaims: StructuredClaim[] };
type FanoutErr = { ok: false; spec: ModelSpec; promptHash: Sha256; error: string };
type FanoutResult = FanoutOk | FanoutErr;

export async function runSynthesis(deps: RunSynthesisDeps, request: SynthesizeRequest): Promise<RunSynthesisResult> {
  const validationError = validate(request);
  if (validationError) {
    return { status: "validation_error", error: validationError, manifest: null, signature: null, raw: [] };
  }

  const requestHash = sha256OfCanonical(request);
  const inputs = await ingestInputs(deps, request);

  const promptInputs = inputs.map((i) => ({ text: i.error ? `(fetch failed: ${i.error})` : i.text }));

  // Sequential fan-out: matches the canonical ecloud-inference-example pattern
  // (default eigen() factory creates an independent JwtProvider per model, so
  // parallel calls would race on /dev/tpmrm0 attestation; serializing avoids it).
  const fanoutResults: FanoutResult[] = [];
  for (const spec of POLICY.MODEL_SET) {
    const { text: promptText, hash: promptHash } = renderPromptForModel({
      provider: spec.provider,
      model: spec.model,
      topic: request.topic,
      inputs: promptInputs,
    });
    try {
      const { rawOutput } = await deps.callModel({ provider: spec.provider, model: spec.model, prompt: promptText });
      const rawOutputSha256 = sha256Hex(rawOutput);
      let parsed: StructuredClaim[];
      try {
        parsed = parseStructuredOutput(rawOutput).claims;
      } catch (e) {
        if (isOpusStructuredOutputFailure(spec, e)) {
          invokeStructuredOutputDebugInfo(deps.onStructuredOutputDebugInfo, {
            code: "structured_output_not_pure_json",
            provider: spec.provider,
            model: spec.model,
            promptHash,
            rawOutputSha256,
            rawOutputByteLength: Buffer.byteLength(rawOutput, "utf8"),
            rawOutput,
          });
        }
        throw e;
      }
      fanoutResults.push({ ok: true, spec, promptHash, rawOutput, rawOutputSha256, parsedClaims: parsed });
    } catch (e) {
      fanoutResults.push({ ok: false, spec, promptHash, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const models: ModelRun[] = fanoutResults.map((r) => ({
    provider: r.spec.provider,
    model: r.spec.model,
    version: r.spec.version,
    promptHash: r.promptHash,
    status: r.ok ? "ok" : "error",
    rawOutputSha256: r.ok ? r.rawOutputSha256 : null,
    parsedClaimCount: r.ok ? r.parsedClaims.length : 0,
    error: r.ok ? null : r.error,
  }));

  const successfulModels = models.filter((m) => m.status === "ok").length;
  const totalModels = POLICY.MODEL_SET.length;
  const thresholdMet = successfulModels >= POLICY.MIN_SUCCESS_COUNT;

  let claims: Claim[] = [];
  let minorityClaims: Claim[] = [];
  let brief = "";

  if (thresholdMet) {
    const consensusInput: ConsensusInput = fanoutResults
      .filter((r): r is FanoutOk => r.ok)
      .map((r) => ({ providerModel: providerModelKey(r.spec), claims: r.parsedClaims }));
    const merged = consensus(consensusInput);
    claims = merged.claims;
    minorityClaims = merged.minorityClaims;
    brief = composeBrief(claims, minorityClaims);
  }

  const consensusThreshold = successfulModels === 0 ? "0" : `ceil(${successfulModels}/2)=${Math.ceil(successfulModels / 2)}`;

  const manifest = buildManifest({
    deployment: deps.deployment,
    request: { topic: request.topic, requestHash },
    inputs: inputs.map(({ text: _t, ...rest }) => rest),
    models,
    merge: { successfulModels, totalModels, thresholdMet, consensusThreshold, claims, minorityClaims },
    brief,
    briefSha256: sha256Hex(brief),
    timestamp: deps.now(),
  });

  const signature = await deps.sign(manifest.manifestSha256);
  const raw: RawModelOutput[] = fanoutResults
    .filter((r): r is FanoutOk => r.ok)
    .map((r) => ({ provider: r.spec.provider, model: r.spec.model, rawOutput: r.rawOutput }));

  return { status: thresholdMet ? "ok" : "threshold_not_met", manifest, signature, raw };
}

export async function runArticleResearch(deps: RunSynthesisDeps, request: NewsResearchRequest): Promise<RunArticleResearchResult> {
  const articleUrl = request.articleUrl.trim();
  if (articleUrl.length === 0) return { status: "validation_error", error: "article_url_required" };
  if (!isHttpUrl(articleUrl)) return { status: "validation_error", error: "article_url_invalid" };

  const article = await deps.fetchUrl(articleUrl);
  const articleRecord: NewsResearchResponse["article"] = {
    url: article.url,
    contentSha256: article.contentSha256,
    ...(article.fetchedAt ? { fetchedAt: article.fetchedAt } : {}),
    byteLength: article.byteLength,
    error: article.error,
  };
  if (article.error) return { status: "fetch_error", error: article.error, article: articleRecord };

  const spec = POLICY.MODEL_SET[0];
  const agentRuns: NewsResearchAgentRun[] = [];

  const plannerPrompt = renderResearchPlannerPrompt(article.url, article.text);
  const plannerPromptHash = sha256Hex(plannerPrompt);
  const plannerRaw = await deps.callModel({ provider: spec.provider, model: spec.model, prompt: plannerPrompt });
  const plannerRawOutputSha256 = sha256Hex(plannerRaw.rawOutput);
  agentRuns.push({
    role: "main",
    provider: spec.provider,
    model: spec.model,
    status: "ok",
    promptHash: plannerPromptHash,
    rawOutputSha256: plannerRawOutputSha256,
    error: null,
  });
  const prompts = parseResearchPrompts(plannerRaw.rawOutput);

  const proPrompt = renderPerspectiveResearchPrompt("pro", prompts.proPrompt, article.url, article.text);
  const proPromptHash = sha256Hex(proPrompt);
  const proRaw = await deps.callModel({ provider: spec.provider, model: spec.model, prompt: proPrompt });
  agentRuns.push({
    role: "pro",
    provider: spec.provider,
    model: spec.model,
    status: "ok",
    promptHash: proPromptHash,
    rawOutputSha256: sha256Hex(proRaw.rawOutput),
    error: null,
  });

  const contraPrompt = renderPerspectiveResearchPrompt("contra", prompts.contraPrompt, article.url, article.text);
  const contraPromptHash = sha256Hex(contraPrompt);
  const contraRaw = await deps.callModel({ provider: spec.provider, model: spec.model, prompt: contraPrompt });
  agentRuns.push({
    role: "contra",
    provider: spec.provider,
    model: spec.model,
    status: "ok",
    promptHash: contraPromptHash,
    rawOutputSha256: sha256Hex(contraRaw.rawOutput),
    error: null,
  });

  return {
    status: "ok",
    article: articleRecord,
    proPrompt: prompts.proPrompt,
    contraPrompt: prompts.contraPrompt,
    proAnalysis: proRaw.rawOutput,
    contraAnalysis: contraRaw.rawOutput,
    mainSummary: composeResearchSummary(proRaw.rawOutput, contraRaw.rawOutput),
    agentRuns,
  };
}

type RichInput = InputRecord & { text: string };

async function ingestInputs(deps: RunSynthesisDeps, request: SynthesizeRequest): Promise<RichInput[]> {
  const out: RichInput[] = [];
  const fetchPromises: Promise<RichInput>[] = [];
  let idx = 0;
  for (const url of request.urls ?? []) {
    const myIdx = idx++;
    fetchPromises.push(
      deps.fetchUrl(url).then((r) => ({
        index: myIdx,
        kind: "url",
        url: r.url,
        contentSha256: r.contentSha256,
        fetchedAt: r.fetchedAt,
        byteLength: r.byteLength,
        error: r.error,
        text: r.text,
      }))
    );
  }
  for (const src of request.sources ?? []) {
    const myIdx = idx++;
    const r = hashText(src.text);
    out[myIdx] = {
      index: myIdx,
      kind: "text",
      url: src.url,
      contentSha256: r.contentSha256,
      byteLength: r.byteLength,
      error: null,
      text: src.text,
    };
  }
  for (const r of await Promise.all(fetchPromises)) out[r.index] = r;
  out.length = idx;
  return out;
}

function composeBrief(consensusClaims: Claim[], minorityClaims: Claim[]): string {
  const lines = ["Consensus claims:"];
  if (consensusClaims.length === 0) lines.push("(none)");
  else for (const c of consensusClaims) lines.push(`- ${c.statement}`);
  lines.push("", "Minority perspectives:");
  if (minorityClaims.length === 0) lines.push("(none)");
  else for (const c of minorityClaims) lines.push(`- ${c.statement} [supported by: ${c.supportingModels.join(", ")}]`);
  return lines.join("\n");
}

function isOpusStructuredOutputFailure(spec: ModelSpec, error: unknown): boolean {
  const model = spec.model as string;
  return spec.provider === "anthropic"
    && model === "claude-opus-4.7"
    && error instanceof Error
    && error.message === "structured_output_not_pure_json";
}

function invokeStructuredOutputDebugInfo(
  onStructuredOutputDebugInfo: RunSynthesisDeps["onStructuredOutputDebugInfo"],
  info: StructuredOutputDebugInfo,
): void {
  if (!onStructuredOutputDebugInfo) return;
  try {
    onStructuredOutputDebugInfo(info);
  } catch {
    // Observability must not affect synthesis outcomes.
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function renderResearchPlannerPrompt(articleUrl: string, articleText: string): string {
  return [
    "You are the main news research agent for eigenisedNews.",
    "Create two research prompts for a news article URL.",
    "The first prompt must ask a pro agent to deeply research evidence that supports, backs, or strengthens the article's framing.",
    "The second prompt must ask a contra agent to deeply research evidence that challenges, weakens, or complicates the article's framing.",
    "Return only JSON with keys proPrompt and contraPrompt. Do not include markdown.",
    `Article URL: ${articleUrl}`,
    "Article text:",
    articleText,
  ].join("\n\n");
}

function renderPerspectiveResearchPrompt(role: "pro" | "contra", researchPrompt: string, articleUrl: string, articleText: string): string {
  const stance = role === "pro" ? "supporting" : "opposing";
  return [
    `You are the ${role} news research agent.` ,
    `Research the ${stance} side of the article using the provided context first.`,
    "Use evidence, cite concrete facts from the article text, and clearly separate facts from inference.",
    "If the article concerns markets, companies, earnings, policy, or governance, mention relevant evidence from the article and identify what further external evidence would be needed.",
    "Research prompt:",
    researchPrompt,
    `Article URL: ${articleUrl}`,
    "Article text:",
    articleText,
  ].join("\n\n");
}

function parseResearchPrompts(rawOutput: string): { proPrompt: string; contraPrompt: string } {
  const parsed = JSON.parse(rawOutput) as unknown;
  if (!isResearchPromptObject(parsed)) throw new Error("research_prompt_parse_failed");
  return { proPrompt: parsed.proPrompt.trim(), contraPrompt: parsed.contraPrompt.trim() };
}

function isResearchPromptObject(value: unknown): value is { proPrompt: string; contraPrompt: string } {
  return typeof value === "object"
    && value !== null
    && "proPrompt" in value
    && typeof value.proPrompt === "string"
    && value.proPrompt.trim().length > 0
    && "contraPrompt" in value
    && typeof value.contraPrompt === "string"
    && value.contraPrompt.trim().length > 0;
}

function composeResearchSummary(proAnalysis: string, contraAnalysis: string): string {
  return ["For the article:", proAnalysis, "", "Against the article:", contraAnalysis].join("\n");
}
