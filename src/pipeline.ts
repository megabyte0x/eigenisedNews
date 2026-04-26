import type { SynthesizeRequest, Manifest, ModelRun, Claim, InputRecord } from "./types";
import { POLICY, providerModelKey, type ModelSpec } from "./lib/policy";
import { canonicalize } from "./lib/canonicalize";
import { sha256OfBytes, sha256Hex } from "./lib/hash";
import type { FetchUrlResult } from "./fetchers/sourceFetcher";
import { hashText } from "./fetchers/sourceFetcher";
import { renderPrompt } from "./fanout/structuredPrompt";
import { parseStructuredOutput } from "./fanout/llmProxy";
import { consensus, type ConsensusInput } from "./merger/consensus";
import { buildManifest } from "./manifest/build";
import type { ManifestSigner } from "./manifest/sign";

export type RunSynthesisDeps = {
  fetchUrl: (url: string) => Promise<FetchUrlResult>;
  callModel: (args: { provider: string; model: string; prompt: string }) => Promise<{ rawOutput: string; latencyMs: number }>;
  now: () => string;
  deployment: Manifest["deployment"];
  sign: ManifestSigner;
};

export type RawModelOutput = { provider: string; model: string; rawOutput: string };

export type RunSynthesisResult =
  | { status: "validation_error"; error: string; manifest: null; signature: null; raw: [] }
  | { status: "threshold_not_met"; manifest: Manifest; signature: `0x${string}`; raw: RawModelOutput[] }
  | { status: "ok"; manifest: Manifest; signature: `0x${string}`; raw: RawModelOutput[] };

type ValidationError = "topic_required" | "topic_too_long" | "no_inputs" | "too_many_inputs";

function validate(req: SynthesizeRequest): ValidationError | null {
  if (typeof req.topic !== "string" || req.topic.length === 0) return "topic_required";
  if (req.topic.length > POLICY.MAX_TOPIC_LEN) return "topic_too_long";
  const total = (req.urls?.length ?? 0) + (req.sources?.length ?? 0);
  if (total === 0) return "no_inputs";
  if (total > POLICY.MAX_INPUTS) return "too_many_inputs";
  return null;
}

type FanoutOk = { ok: true; spec: ModelSpec; rawOutput: string; rawOutputSha256: ReturnType<typeof sha256Hex>; parsedClaims: { statement: string; supportingSourceIndices: number[] }[] };
type FanoutErr = { ok: false; spec: ModelSpec; error: string };
type FanoutResult = FanoutOk | FanoutErr;

export async function runSynthesis(deps: RunSynthesisDeps, request: SynthesizeRequest): Promise<RunSynthesisResult> {
  const validationError = validate(request);
  if (validationError) {
    return { status: "validation_error", error: validationError, manifest: null, signature: null, raw: [] };
  }

  const requestHash = sha256OfBytes(canonicalize(request));
  const inputs = await ingestInputs(deps, request);

  const promptInputs = inputs.map((i) => ({ text: i.error ? `(fetch failed: ${i.error})` : i.text }));
  const { text: promptText, hash: promptHash } = renderPrompt(request.topic, promptInputs);

  const fanoutResults = await Promise.all(
    POLICY.MODEL_SET.map(async (spec): Promise<FanoutResult> => {
      try {
        const { rawOutput } = await deps.callModel({ provider: spec.provider, model: spec.model, prompt: promptText });
        const parsed = parseStructuredOutput(rawOutput);
        return { ok: true, spec, rawOutput, rawOutputSha256: sha256Hex(rawOutput), parsedClaims: parsed.claims };
      } catch (e) {
        return { ok: false, spec, error: e instanceof Error ? e.message : String(e) };
      }
    })
  );

  const models: ModelRun[] = fanoutResults.map((r) => ({
    provider: r.spec.provider,
    model: r.spec.model,
    version: r.spec.version,
    promptHash,
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
