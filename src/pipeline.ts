import type { SynthesizeRequest, Manifest, ModelRun, Claim, InputRecord } from "./types";
import { POLICY } from "./lib/policy";
import { canonicalize } from "./lib/canonicalize";
import { sha256OfBytes, sha256Hex } from "./lib/hash";
import type { FetchUrlResult } from "./fetchers/sourceFetcher";
import { hashText } from "./fetchers/sourceFetcher";
import { renderPrompt } from "./fanout/structuredPrompt";
import { parseStructuredOutput } from "./fanout/llmProxy";
import { consensus, type ConsensusInput } from "./merger/consensus";
import { buildManifest } from "./manifest/build";
import { signManifestSha256 } from "./manifest/sign";

export type RunSynthesisDeps = {
  fetchUrl: (url: string) => Promise<FetchUrlResult>;
  callModel: (args: { provider: string; model: string; version: string; prompt: string }) => Promise<{ rawOutput: string; latencyMs: number }>;
  now: () => string;
  deployment: Manifest["deployment"];
  signerPrivateKey: `0x${string}`;
};

export type RawModelOutput = { provider: string; model: string; rawOutput: string };

export type RunSynthesisResult =
  | { status: "validation_error"; error: string; manifest: null; signature: null; raw: [] }
  | { status: "threshold_not_met"; manifest: Manifest; signature: `0x${string}`; raw: RawModelOutput[] }
  | { status: "ok"; manifest: Manifest; signature: `0x${string}`; raw: RawModelOutput[] };

function validate(req: SynthesizeRequest): string | null {
  if (typeof req.topic !== "string" || req.topic.length === 0) return "topic_required";
  if (req.topic.length > POLICY.MAX_TOPIC_LEN) return "topic_too_long";
  const total = (req.urls?.length ?? 0) + (req.sources?.length ?? 0);
  if (total === 0) return "no_inputs";
  if (total > POLICY.MAX_INPUTS) return "too_many_inputs";
  return null;
}

type RichInput = InputRecord & { text: string };

export async function runSynthesis(deps: RunSynthesisDeps, request: SynthesizeRequest): Promise<RunSynthesisResult> {
  const validationError = validate(request);
  if (validationError) {
    return { status: "validation_error", error: validationError, manifest: null, signature: null, raw: [] };
  }

  const requestHash = sha256OfBytes(canonicalize(request));

  const richInputs: RichInput[] = [];
  const fetchPromises: Promise<RichInput>[] = [];
  let idx = 0;
  for (const url of request.urls ?? []) {
    const myIdx = idx++;
    fetchPromises.push(
      deps.fetchUrl(url).then((r) => {
        const rec: RichInput = {
          index: myIdx,
          kind: "url",
          url: r.url,
          contentSha256: r.contentSha256,
          byteLength: r.byteLength,
          error: r.error,
          text: r.text,
        };
        if (r.fetchedAt) rec.fetchedAt = r.fetchedAt;
        return rec;
      })
    );
  }
  for (const src of request.sources ?? []) {
    const myIdx = idx++;
    const r = hashText(src.text);
    const rec: RichInput = {
      index: myIdx,
      kind: "text",
      contentSha256: r.contentSha256,
      byteLength: r.byteLength,
      error: null,
      text: src.text,
    };
    if (src.url !== undefined) rec.url = src.url;
    richInputs[myIdx] = rec;
  }
  const fetched = await Promise.all(fetchPromises);
  for (const r of fetched) richInputs[r.index] = r;
  richInputs.length = idx;

  const inputsForManifest: InputRecord[] = richInputs.map(({ text: _t, ...rest }) => {
    // Strip undefined fields so canonicalization is total.
    const out: InputRecord = {
      index: rest.index,
      kind: rest.kind,
      contentSha256: rest.contentSha256,
      byteLength: rest.byteLength,
      error: rest.error,
    };
    if (rest.url !== undefined) out.url = rest.url;
    if (rest.fetchedAt !== undefined) out.fetchedAt = rest.fetchedAt;
    return out;
  });

  const promptInputs = richInputs.map((r) => ({
    text: r.error ? `(fetch failed: ${r.error})` : r.text,
  }));
  const { text: promptText, hash: promptHash } = renderPrompt(request.topic, promptInputs);

  type FanoutOk = { ok: true; spec: typeof POLICY.MODEL_SET[number]; rawOutput: string; rawOutputSha256: ReturnType<typeof sha256Hex>; parsedClaims: { statement: string; supportingSourceIndices: number[] }[] };
  type FanoutErr = { ok: false; spec: typeof POLICY.MODEL_SET[number]; error: string };
  type FanoutResult = FanoutOk | FanoutErr;

  const fanoutResults: FanoutResult[] = await Promise.all(
    POLICY.MODEL_SET.map(async (spec): Promise<FanoutResult> => {
      try {
        const { rawOutput } = await deps.callModel({ ...spec, prompt: promptText });
        const parsed = parseStructuredOutput(rawOutput);
        return { ok: true, spec, rawOutput, rawOutputSha256: sha256Hex(rawOutput), parsedClaims: parsed.claims };
      } catch (e) {
        return { ok: false, spec, error: e instanceof Error ? e.message : String(e) };
      }
    })
  );

  const models: ModelRun[] = fanoutResults.map((r) =>
    r.ok
      ? {
          provider: r.spec.provider,
          model: r.spec.model,
          version: r.spec.version,
          promptHash,
          status: "ok",
          rawOutputSha256: r.rawOutputSha256,
          parsedClaimCount: r.parsedClaims.length,
          error: null,
        }
      : {
          provider: r.spec.provider,
          model: r.spec.model,
          version: r.spec.version,
          promptHash,
          status: "error",
          rawOutputSha256: null,
          parsedClaimCount: 0,
          error: r.error,
        }
  );

  const successfulModels = models.filter((m) => m.status === "ok").length;
  const totalModels = POLICY.MODEL_SET.length;
  const thresholdMet = successfulModels >= POLICY.MIN_SUCCESS_COUNT;

  let claims: Claim[] = [];
  let minorityClaims: Claim[] = [];
  let brief = "";

  if (thresholdMet) {
    const consensusInput: ConsensusInput = fanoutResults
      .filter((r): r is FanoutOk => r.ok)
      .map((r) => ({
        providerModel: `${r.spec.provider}/${r.spec.model}`,
        claims: r.parsedClaims,
      }));
    const merged = consensus(consensusInput);
    claims = merged.claims;
    minorityClaims = merged.minorityClaims;
    brief = composeBrief(claims, minorityClaims);
  }

  const briefSha256 = sha256Hex(brief);

  const manifest = buildManifest({
    deployment: deps.deployment,
    request: { topic: request.topic, requestHash },
    inputs: inputsForManifest,
    models,
    merge: {
      successfulModels,
      totalModels,
      thresholdMet,
      consensusThreshold: "ceil(N_success/2)",
      claims,
      minorityClaims,
    },
    brief,
    briefSha256,
    timestamp: deps.now(),
  });

  const signature = await signManifestSha256(deps.signerPrivateKey, manifest.manifestSha256);
  const raw: RawModelOutput[] = fanoutResults
    .filter((r): r is FanoutOk => r.ok)
    .map((r) => ({ provider: r.spec.provider, model: r.spec.model, rawOutput: r.rawOutput }));

  return {
    status: thresholdMet ? "ok" : "threshold_not_met",
    manifest,
    signature,
    raw,
  };
}

function composeBrief(consensusClaims: Claim[], minorityClaims: Claim[]): string {
  const lines: string[] = [];
  lines.push("Consensus claims:");
  if (consensusClaims.length === 0) lines.push("(none)");
  else for (const c of consensusClaims) lines.push(`- ${c.statement}`);
  lines.push("");
  lines.push("Minority perspectives:");
  if (minorityClaims.length === 0) lines.push("(none)");
  else for (const c of minorityClaims) lines.push(`- ${c.statement} [supported by: ${c.supportingModels.join(", ")}]`);
  return lines.join("\n");
}
