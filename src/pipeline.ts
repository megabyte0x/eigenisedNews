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
  NewsResearchAgentRole,
  NewsResearchPromptBinding,
  NewsResearchRaw,
  NewsResearchRawAgentOutput,
  NewsResearchVerifiableBuild,
} from "./types";
import { POLICY, providerModelKey, type ModelSpec } from "./lib/policy";
import { sha256OfCanonical } from "./lib/canonicalHash";
import { sha256Hex } from "./lib/hash";
import { log } from "./lib/log";
import type { FetchUrlResult } from "./fetchers/sourceFetcher";
import { hashText } from "./fetchers/sourceFetcher";
import { renderPromptForModel } from "./fanout/structuredPrompt";
import { extractStructuredOutputJson, parseStructuredOutput } from "./fanout/llmProxy";
import { consensus, type ConsensusInput } from "./merger/consensus";
import { buildManifest, buildResearchManifest } from "./manifest/build";
import type { ManifestSigner } from "./manifest/sign";
import type { Sha256 } from "./lib/hash";

export type RunSynthesisDeps = {
  fetchUrl: (url: string) => Promise<FetchUrlResult>;
  callModel: (args: { provider: string; model: string; prompt: string; timeoutMs?: number; maxOutputTokens?: number }) => Promise<{ rawOutput: string; latencyMs: number }>;
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
  | ({ status: "ok"; raw: NewsResearchRaw } & Omit<NewsResearchResponse, "raw">);

const RESEARCH_PROMPT_SOURCE_PATH = "src/pipeline.ts";
const SOURCE_REPOSITORY_URL = "https://github.com/megabyte0x/eigenisedNews";

const RESEARCH_PLANNER_SYSTEM_PROMPT = [
  "You are the main news research agent for eigenisedNews.",
  "Create two research prompts for a news article URL.",
  "The first prompt must ask a pro agent to deeply research evidence that supports, backs, or strengthens the article's framing.",
  "The second prompt must ask a contra agent to deeply research evidence that challenges, weakens, or complicates the article's framing.",
  "Keep each generated prompt under 600 characters and focused on the 3 strongest lines of inquiry.",
  "Return only JSON with keys proPrompt and contraPrompt. Do not include markdown.",
].join("\n");

const RESEARCH_PRO_SYSTEM_PROMPT = [
  "You are the pro news research agent.",
  "Research the supporting side of the article using the provided context first.",
  "Use evidence, cite concrete facts from the article text, and clearly separate facts from inference.",
  "If the article concerns markets, companies, earnings, policy, or governance, mention relevant evidence from the article and identify what further external evidence would be needed.",
  "Keep the answer concise: at most 6 bullets plus one short verdict, under 500 words total.",
].join("\n");

const RESEARCH_CONTRA_SYSTEM_PROMPT = [
  "You are the contra news research agent.",
  "Research the opposing side of the article using the provided context first.",
  "Use evidence, cite concrete facts from the article text, and clearly separate facts from inference.",
  "If the article concerns markets, companies, earnings, policy, or governance, mention relevant evidence from the article and identify what further external evidence would be needed.",
  "Keep the answer concise: at most 6 bullets plus one short verdict, under 500 words total.",
].join("\n");

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

  const requestHash = sha256OfCanonical({ articleUrl });
  const requestId = request.requestId ?? "standalone";
  const articleUrlHash = sha256Hex(articleUrl);
  const articleHost = new URL(articleUrl).host;
  const fetchStartedAt = Date.now();
  log("info", "research_fetch_started", { requestId, route: "/research", articleHost, articleUrlHash });
  const article = await deps.fetchUrl(articleUrl);
  const fetchLatencyMs = Date.now() - fetchStartedAt;
  const articleRecord: NewsResearchResponse["article"] = {
    url: article.url,
    contentSha256: article.contentSha256,
    ...(article.fetchedAt ? { fetchedAt: article.fetchedAt } : {}),
    byteLength: article.byteLength,
    error: article.error,
  };
  const fetchedArticleUrlHash = sha256Hex(article.url);
  if (article.error) {
    log("warn", "research_fetch_failed", {
      requestId,
      route: "/research",
      articleHost: new URL(article.url).host,
      articleUrlHash: fetchedArticleUrlHash,
      error: article.error,
      byteLength: article.byteLength,
      latencyMs: fetchLatencyMs,
    });
    return { status: "fetch_error", error: article.error, article: articleRecord };
  }
  log("info", "research_fetch_completed", {
    requestId,
    route: "/research",
    articleHost: new URL(article.url).host,
    articleUrlHash: fetchedArticleUrlHash,
    contentSha256: article.contentSha256,
    byteLength: article.byteLength,
    latencyMs: fetchLatencyMs,
  });

  const spec = POLICY.MODEL_SET[0];
  const agentRuns: NewsResearchAgentRun[] = [];
  const promptBindings: NewsResearchPromptBinding[] = [];

  const articleContext = prepareArticleContext(article.text);
  log("info", "research_context_prepared", {
    requestId,
    route: "/research",
    articleHost: new URL(article.url).host,
    articleUrlHash: fetchedArticleUrlHash,
    source: articleContext.source,
    originalCharLength: articleContext.originalCharLength,
    normalizedCharLength: articleContext.normalizedCharLength,
    contextCharLength: articleContext.text.length,
    truncated: articleContext.truncated,
    maxChars: POLICY.RESEARCH_ARTICLE_CONTEXT_MAX_CHARS,
  });

  const plannerPrompt = renderResearchPlannerPrompt(article.url, articleContext.text);
  const plannerPromptHash = sha256Hex(plannerPrompt);
  promptBindings.push(buildResearchPromptBinding({
    role: "main",
    provider: spec.provider,
    model: spec.model,
    systemPrompt: RESEARCH_PLANNER_SYSTEM_PROMPT,
    promptHash: plannerPromptHash,
    articleUrl: article.url,
    articleContentSha256: article.contentSha256,
    researchPrompt: null,
  }));
  const plannerRaw = await callResearchAgent(deps, {
    requestId,
    stage: "main",
    provider: spec.provider,
    model: spec.model,
    prompt: plannerPrompt,
    promptHash: plannerPromptHash,
    timeoutMs: POLICY.RESEARCH_LLM_TIMEOUT_MS,
    maxOutputTokens: POLICY.RESEARCH_LLM_MAX_OUTPUT_TOKENS,
  });
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

  const proPrompt = renderPerspectiveResearchPrompt("pro", prompts.proPrompt, article.url, articleContext.text);
  const proPromptHash = sha256Hex(proPrompt);
  promptBindings.push(buildResearchPromptBinding({
    role: "pro",
    provider: spec.provider,
    model: spec.model,
    systemPrompt: RESEARCH_PRO_SYSTEM_PROMPT,
    promptHash: proPromptHash,
    articleUrl: article.url,
    articleContentSha256: article.contentSha256,
    researchPrompt: prompts.proPrompt,
  }));
  const proRaw = await callResearchAgent(deps, {
    requestId,
    stage: "pro",
    provider: spec.provider,
    model: spec.model,
    prompt: proPrompt,
    promptHash: proPromptHash,
    timeoutMs: POLICY.RESEARCH_LLM_TIMEOUT_MS,
    maxOutputTokens: POLICY.RESEARCH_LLM_MAX_OUTPUT_TOKENS,
  });
  const proRawOutputSha256 = sha256Hex(proRaw.rawOutput);
  agentRuns.push({
    role: "pro",
    provider: spec.provider,
    model: spec.model,
    status: "ok",
    promptHash: proPromptHash,
    rawOutputSha256: proRawOutputSha256,
    error: null,
  });

  const contraPrompt = renderPerspectiveResearchPrompt("contra", prompts.contraPrompt, article.url, articleContext.text);
  const contraPromptHash = sha256Hex(contraPrompt);
  promptBindings.push(buildResearchPromptBinding({
    role: "contra",
    provider: spec.provider,
    model: spec.model,
    systemPrompt: RESEARCH_CONTRA_SYSTEM_PROMPT,
    promptHash: contraPromptHash,
    articleUrl: article.url,
    articleContentSha256: article.contentSha256,
    researchPrompt: prompts.contraPrompt,
  }));
  const contraRaw = await callResearchAgent(deps, {
    requestId,
    stage: "contra",
    provider: spec.provider,
    model: spec.model,
    prompt: contraPrompt,
    promptHash: contraPromptHash,
    timeoutMs: POLICY.RESEARCH_LLM_TIMEOUT_MS,
    maxOutputTokens: POLICY.RESEARCH_LLM_MAX_OUTPUT_TOKENS,
  });
  const contraRawOutputSha256 = sha256Hex(contraRaw.rawOutput);
  agentRuns.push({
    role: "contra",
    provider: spec.provider,
    model: spec.model,
    status: "ok",
    promptHash: contraPromptHash,
    rawOutputSha256: contraRawOutputSha256,
    error: null,
  });

  const mainSummary = composeResearchSummary(proRaw.rawOutput, contraRaw.rawOutput);
  const verifiableBuild = buildResearchVerifiableBuild(deps.deployment);
  const raw: NewsResearchRaw = {
    agentOutputs: [
      buildResearchRawAgentOutput("main", spec.provider, spec.model, plannerPrompt, plannerRaw.rawOutput),
      buildResearchRawAgentOutput("pro", spec.provider, spec.model, proPrompt, proRaw.rawOutput),
      buildResearchRawAgentOutput("contra", spec.provider, spec.model, contraPrompt, contraRaw.rawOutput),
    ],
    mainSummary,
  };
  const manifest = buildResearchManifest({
    deployment: deps.deployment,
    request: { articleUrl, requestHash },
    article: articleRecord,
    promptBindings,
    agentRuns,
    outputs: {
      proPromptSha256: sha256Hex(prompts.proPrompt),
      contraPromptSha256: sha256Hex(prompts.contraPrompt),
      proAnalysisSha256: proRawOutputSha256,
      contraAnalysisSha256: contraRawOutputSha256,
      mainSummarySha256: sha256Hex(mainSummary),
      summaryAlgorithm: "composeResearchSummary/v1",
    },
    timestamp: deps.now(),
  });
  const signature = await deps.sign(manifest.manifestSha256);

  return {
    status: "ok",
    article: articleRecord,
    proPrompt: prompts.proPrompt,
    contraPrompt: prompts.contraPrompt,
    proAnalysis: proRaw.rawOutput,
    contraAnalysis: contraRaw.rawOutput,
    mainSummary,
    promptBindings,
    verifiableBuild,
    agentRuns,
    manifest,
    signature,
    raw,
  };
}

type PreparedArticleContext = {
  text: string;
  source: "html_to_text" | "plain_text";
  originalCharLength: number;
  normalizedCharLength: number;
  truncated: boolean;
};

function buildResearchPromptBinding(args: {
  role: NewsResearchAgentRole;
  provider: string;
  model: string;
  systemPrompt: string;
  promptHash: Sha256;
  articleUrl: string;
  articleContentSha256: Sha256 | null;
  researchPrompt: string | null;
}): NewsResearchPromptBinding {
  return {
    role: args.role,
    perspective: researchPerspectiveForRole(args.role),
    provider: args.provider,
    model: args.model,
    systemPrompt: args.systemPrompt,
    systemPromptSha256: sha256Hex(args.systemPrompt),
    promptHash: args.promptHash,
    articleUrl: args.articleUrl,
    articleContentSha256: args.articleContentSha256,
    researchPrompt: args.researchPrompt,
  };
}

function buildResearchRawAgentOutput(
  role: NewsResearchAgentRole,
  provider: string,
  model: string,
  prompt: string,
  rawOutput: string,
): NewsResearchRawAgentOutput {
  return { role, provider, model, prompt, rawOutput };
}

function researchPerspectiveForRole(role: NewsResearchAgentRole): NewsResearchPromptBinding["perspective"] {
  if (role === "main") return "planner";
  return role === "pro" ? "supports_article" : "challenges_article";
}

function buildResearchVerifiableBuild(deployment: Manifest["deployment"]): NewsResearchVerifiableBuild {
  const appIdentifier = deployment.appId !== "local" && deployment.appId !== "unknown"
    ? deployment.appId
    : deployment.agentAddress !== "unknown"
      ? deployment.agentAddress
      : null;
  const commitSha = deployment.commitSha.trim();
  const hasCommit = commitSha.length > 0 && commitSha !== "unknown";
  return {
    ...deployment,
    dashboardUrl: appIdentifier ? dashboardUrlForEnvironment(deployment.environment, appIdentifier) : null,
    promptSourcePath: RESEARCH_PROMPT_SOURCE_PATH,
    promptSourceUrl: hasCommit ? `${SOURCE_REPOSITORY_URL}/blob/${commitSha}/${RESEARCH_PROMPT_SOURCE_PATH}` : null,
  };
}

function dashboardUrlForEnvironment(environment: Manifest["deployment"]["environment"], appIdentifier: string): string | null {
  if (environment === "mainnet-alpha") return `https://verify.eigencloud.xyz/app/${appIdentifier}`;
  if (environment === "sepolia") return `https://verify-sepolia.eigencloud.xyz/app/${appIdentifier}`;
  return null;
}

async function callResearchAgent(
  deps: RunSynthesisDeps,
  args: { requestId: string; stage: "main" | "pro" | "contra"; provider: string; model: string; prompt: string; promptHash: Sha256; timeoutMs: number; maxOutputTokens: number },
): Promise<{ rawOutput: string; latencyMs: number }> {
  const startedAt = Date.now();
  log("info", "research_stage_started", {
    requestId: args.requestId,
    route: "/research",
    stage: args.stage,
    provider: args.provider,
    model: args.model,
    timeoutMs: args.timeoutMs,
    maxOutputTokens: args.maxOutputTokens,
    promptHash: args.promptHash,
    promptCharLength: args.prompt.length,
  });
  try {
    const result = await deps.callModel({ provider: args.provider, model: args.model, prompt: args.prompt, timeoutMs: args.timeoutMs, maxOutputTokens: args.maxOutputTokens });
    log("info", "research_stage_completed", {
      requestId: args.requestId,
      route: "/research",
      stage: args.stage,
      provider: args.provider,
      model: args.model,
      timeoutMs: args.timeoutMs,
      maxOutputTokens: args.maxOutputTokens,
      promptHash: args.promptHash,
      rawOutputSha256: sha256Hex(result.rawOutput),
      rawOutputByteLength: Buffer.byteLength(result.rawOutput, "utf8"),
      latencyMs: Date.now() - startedAt,
      modelLatencyMs: result.latencyMs,
    });
    return result;
  } catch (error) {
    log("error", "research_stage_failed", {
      requestId: args.requestId,
      route: "/research",
      stage: args.stage,
      provider: args.provider,
      model: args.model,
      timeoutMs: args.timeoutMs,
      maxOutputTokens: args.maxOutputTokens,
      promptHash: args.promptHash,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    });
    throw error;
  }
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
    RESEARCH_PLANNER_SYSTEM_PROMPT,
    `Article URL: ${articleUrl}`,
    "Article text:",
    articleText,
  ].join("\n\n");
}

function prepareArticleContext(text: string): PreparedArticleContext {
  const html = looksLikeHtml(text);
  const readableText = html ? htmlToReadableText(text) : text;
  const normalized = decodeHtmlEntities(readableText).replace(/\s+/g, " ").trim();
  const maxChars = POLICY.RESEARCH_ARTICLE_CONTEXT_MAX_CHARS;
  if (normalized.length <= maxChars) {
    return { text: normalized, source: html ? "html_to_text" : "plain_text", originalCharLength: text.length, normalizedCharLength: normalized.length, truncated: false };
  }
  return {
    text: `${normalized.slice(0, maxChars)}\n...[truncated for research context: kept first ${maxChars} of ${normalized.length} normalized chars]`,
    source: html ? "html_to_text" : "plain_text",
    originalCharLength: text.length,
    normalizedCharLength: normalized.length,
    truncated: true,
  };
}

function looksLikeHtml(text: string): boolean {
  return /<html[\s>]/i.test(text) || /<body[\s>]/i.test(text) || /<!doctype html/i.test(text);
}

function htmlToReadableText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<\/(p|div|section|article|header|footer|li|h[1-6]|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return decodeCodePoint(codePoint, match);
    }
    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return decodeCodePoint(codePoint, match);
    }
    return named[lower] ?? match;
  });
}

function decodeCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isFinite(codePoint)) return fallback;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

function renderPerspectiveResearchPrompt(role: "pro" | "contra", researchPrompt: string, articleUrl: string, articleText: string): string {
  return [
    role === "pro" ? RESEARCH_PRO_SYSTEM_PROMPT : RESEARCH_CONTRA_SYSTEM_PROMPT,
    "Research prompt:",
    researchPrompt,
    `Article URL: ${articleUrl}`,
    "Article text:",
    articleText,
  ].join("\n\n");
}

export function parseResearchPrompts(rawOutput: string): { proPrompt: string; contraPrompt: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractStructuredOutputJson(rawOutput)) as unknown;
  } catch {
    throw new Error("research_prompt_parse_failed");
  }
  if (!isResearchPromptObject(parsed)) throw new Error("research_prompt_parse_failed");
  return { proPrompt: compactResearchPrompt(parsed.proPrompt), contraPrompt: compactResearchPrompt(parsed.contraPrompt) };
}

function compactResearchPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= 700) return normalized;
  return `${normalized.slice(0, 700)}...`;
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

export function composeResearchSummary(proAnalysis: string, contraAnalysis: string): string {
  return ["For the article:", proAnalysis, "", "Against the article:", contraAnalysis].join("\n");
}
