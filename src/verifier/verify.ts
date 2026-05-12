import type {
  Manifest,
  NewsResearchManifest,
  NewsResearchResponse,
  SynthesizeResponse,
} from "../types";
import { sha256Hex } from "../lib/hash";
import { sha256OfCanonical } from "../lib/canonicalHash";
import { providerModelKey } from "../lib/policy";
import { isUnknownRecord } from "../lib/guards";
import {
  isHexSignature,
  isManifest,
  isNewsResearchRaw,
  isNewsResearchResponse,
  isRawModelOutput,
  isResearchManifest,
  isSynthesizeResponse,
} from "../lib/manifestGuards";
import { hashManifestWithPlaceholder, hashResearchManifestWithPlaceholder } from "../manifest/build";
import { recoverManifestSigner } from "../manifest/sign";
import { parseStructuredOutput } from "../fanout/llmProxy";
import { consensus, type ConsensusInput } from "../merger/consensus";
import { fetchUrl as defaultFetchUrl, type FetchUrlResult } from "../fetchers/sourceFetcher";
import { composeResearchSummary, parseResearchPrompts } from "../pipeline";
import { matchProvenance, type ProvenanceChecker } from "./provenance";
import type { CheckResult } from "./types";

export type { CheckResult } from "./types";

export type VerifyOptions = {
  refetchInputs?: boolean;
  fetchUrl?: (url: string) => Promise<FetchUrlResult>;
  provenance?: ProvenanceChecker;
};

export async function verifyResponse(response: unknown, opts: VerifyOptions = {}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const parsed = parseResponse(response);
  out.push(parsed.schema);
  if (!parsed.ok) return out;
  if (parsed.kind === "research") {
    const typedResponse = parsed.response;
    const m = typedResponse.manifest;

    const recomputed = hashResearchManifestWithPlaceholder(m);
    out.push(
      recomputed === m.manifestSha256
        ? { name: "manifest_hash", status: "pass", detail: m.manifestSha256 }
        : { name: "manifest_hash", status: "fail", detail: `recomputed ${recomputed} != claimed ${m.manifestSha256}` }
    );
    out.push(await verifySignature(m.manifestSha256, typedResponse.signature, m.deployment.agentAddress));
    out.push(await verifyResearchArticle(m, opts));
    out.push(verifyResearchOutputs(typedResponse));
    out.push(verifyResearchRawOutputs(typedResponse));
    out.push(await verifyProvenance(m.deployment, opts));
    return out;
  }

  const typedResponse = parsed.response;
  const m = typedResponse.manifest;

  const recomputed = hashManifestWithPlaceholder(m);
  out.push(
    recomputed === m.manifestSha256
      ? { name: "manifest_hash", status: "pass", detail: m.manifestSha256 }
      : { name: "manifest_hash", status: "fail", detail: `recomputed ${recomputed} != claimed ${m.manifestSha256}` }
  );

  out.push(await verifySignature(m.manifestSha256, typedResponse.signature, m.deployment.agentAddress));

  out.push(await verifyInputs(m, opts));
  const rawCheck = verifyRawOutputs(m, typedResponse.raw);
  out.push(rawCheck);
  out.push(rawCheck.status === "fail" ? { name: "merge", status: "skip", detail: "raw_outputs failed" } : verifyMerge(m, typedResponse.raw));
  out.push(await verifyProvenance(m.deployment, opts));

  return out;
}

async function verifySignature(manifestSha256: string, signature: `0x${string}`, agentAddress: string): Promise<CheckResult> {
  try {
    const recovered = await recoverManifestSigner(manifestSha256 as `sha256:${string}`, signature);
    return recovered.toLowerCase() === agentAddress.toLowerCase()
      ? { name: "signature", status: "pass", detail: `recovered ${recovered}` }
      : { name: "signature", status: "fail", detail: `recovered ${recovered} != claimed ${agentAddress}` };
  } catch (e) {
    return { name: "signature", status: "fail", detail: e instanceof Error ? e.message : String(e) };
  }
}

type ParsedResponse =
  | { ok: true; kind: "synthesize"; schema: CheckResult; response: SynthesizeResponse }
  | { ok: true; kind: "research"; schema: CheckResult; response: NewsResearchResponse }
  | { ok: false; schema: CheckResult };

function parseResponse(response: unknown): ParsedResponse {
  if (!isUnknownRecord(response)) return { ok: false, schema: { name: "schema", status: "fail", detail: "response is not an object" } };
  if (isResearchManifest(response.manifest)) {
    if (!isHexSignature(response.signature)) {
      return { ok: false, schema: { name: "schema", status: "fail", detail: "signature missing or invalid" } };
    }
    if (response.raw !== null && !isNewsResearchRaw(response.raw)) {
      return { ok: false, schema: { name: "schema", status: "fail", detail: "research raw must be null or a research raw object" } };
    }
    if (!isNewsResearchResponse(response)) {
      return { ok: false, schema: { name: "schema", status: "fail", detail: "research response missing or malformed" } };
    }
    return {
      ok: true,
      kind: "research",
      schema: { name: "schema", status: "pass", detail: "research response shape is valid" },
      response,
    };
  }
  if (!isManifest(response.manifest)) return { ok: false, schema: { name: "schema", status: "fail", detail: "manifest missing or malformed" } };
  if (!isHexSignature(response.signature)) {
    return { ok: false, schema: { name: "schema", status: "fail", detail: "signature missing or invalid" } };
  }
  if (response.raw !== null && (!Array.isArray(response.raw) || !response.raw.every(isRawModelOutput))) {
    return { ok: false, schema: { name: "schema", status: "fail", detail: "raw must be null or an array of raw model outputs" } };
  }
  if (!isSynthesizeResponse(response)) return { ok: false, schema: { name: "schema", status: "fail", detail: "response shape is invalid" } };
  return {
    ok: true,
    kind: "synthesize",
    schema: { name: "schema", status: "pass", detail: "response shape is valid" },
    response,
  };
}

function verifyRawOutputs(m: SynthesizeResponse["manifest"], raw: SynthesizeResponse["raw"]): CheckResult {
  if (!raw) return { name: "raw_outputs", status: "skip", detail: "no raw outputs in response" };

  const okModels = m.models.filter((mm) => mm.status === "ok");
  const expectedKeys = new Set(okModels.map((mm) => providerModelKey(mm)));
  const rawByKey = new Map<string, NonNullable<SynthesizeResponse["raw"]>[number]>();

  for (const r of raw) {
    const key = providerModelKey(r);
    if (!expectedKeys.has(key)) return { name: "raw_outputs", status: "fail", detail: `unexpected raw output for ${key}` };
    if (rawByKey.has(key)) return { name: "raw_outputs", status: "fail", detail: `duplicate raw output for ${key}` };
    rawByKey.set(key, r);
  }

  for (const model of okModels) {
    const key = providerModelKey(model);
    const r = rawByKey.get(key);
    if (!r) return { name: "raw_outputs", status: "fail", detail: `missing raw output for ${key}` };
    const actualHash = sha256Hex(r.rawOutput);
    if (actualHash !== model.rawOutputSha256) {
      return { name: "raw_outputs", status: "fail", detail: `raw hash mismatch for ${key}` };
    }
    try {
      const parsed = parseStructuredOutput(r.rawOutput);
      if (parsed.claims.length !== model.parsedClaimCount) {
        return { name: "raw_outputs", status: "fail", detail: `parsed claim count mismatch for ${key}` };
      }
    } catch (e) {
      return { name: "raw_outputs", status: "fail", detail: `failed to parse raw output for ${key}: ${e instanceof Error ? e.message : e}` };
    }
  }

  return { name: "raw_outputs", status: "pass", detail: `${okModels.length} successful model raw outputs verified` };
}

function verifyResearchOutputs(response: NewsResearchResponse): CheckResult {
  const m = response.manifest;
  const mismatches: string[] = [];

  if (!canonicalEquals(response.article, m.article)) mismatches.push("article");
  if (!canonicalEquals(response.promptBindings, m.promptBindings)) mismatches.push("promptBindings");
  if (!canonicalEquals(response.agentRuns, m.agentRuns)) mismatches.push("agentRuns");
  if (!hasResearchRoles(response.promptBindings)) mismatches.push("promptBindingRoles");
  if (!hasResearchRoles(response.agentRuns)) mismatches.push("agentRunRoles");
  if (sha256Hex(response.proPrompt) !== m.outputs.proPromptSha256) mismatches.push("proPromptSha256");
  if (sha256Hex(response.contraPrompt) !== m.outputs.contraPromptSha256) mismatches.push("contraPromptSha256");
  if (sha256Hex(response.proAnalysis) !== m.outputs.proAnalysisSha256) mismatches.push("proAnalysisSha256");
  if (sha256Hex(response.contraAnalysis) !== m.outputs.contraAnalysisSha256) mismatches.push("contraAnalysisSha256");
  if (sha256Hex(response.mainSummary) !== m.outputs.mainSummarySha256) mismatches.push("mainSummarySha256");
  if (composeResearchSummary(response.proAnalysis, response.contraAnalysis) !== response.mainSummary) mismatches.push("mainSummary");

  return mismatches.length === 0
    ? { name: "research_outputs", status: "pass", detail: "response fields match research manifest" }
    : { name: "research_outputs", status: "fail", detail: `mismatch: ${mismatches.join(", ")}` };
}

function verifyResearchRawOutputs(response: NewsResearchResponse): CheckResult {
  const raw = response.raw;
  if (!raw) return { name: "research_raw", status: "skip", detail: "no raw research payload in response" };
  if (raw.mainSummary !== response.mainSummary) return { name: "research_raw", status: "fail", detail: "raw mainSummary mismatch" };

  const rawByRole = new Map(raw.agentOutputs.map((item) => [item.role, item]));
  if (rawByRole.size !== raw.agentOutputs.length) return { name: "research_raw", status: "fail", detail: "duplicate raw agent role" };
  if (raw.agentOutputs.length !== response.manifest.agentRuns.length) return { name: "research_raw", status: "fail", detail: "unexpected raw output count" };

  for (const run of response.manifest.agentRuns) {
    const rawOutput = rawByRole.get(run.role);
    if (!rawOutput) return { name: "research_raw", status: "fail", detail: `missing raw output for ${run.role}` };
    if (rawOutput.provider !== run.provider || rawOutput.model !== run.model) {
      return { name: "research_raw", status: "fail", detail: `provider/model mismatch for ${run.role}` };
    }
    if (sha256Hex(rawOutput.prompt) !== run.promptHash) {
      return { name: "research_raw", status: "fail", detail: `prompt hash mismatch for ${run.role}` };
    }
    if (sha256Hex(rawOutput.rawOutput) !== run.rawOutputSha256) {
      return { name: "research_raw", status: "fail", detail: `raw output hash mismatch for ${run.role}` };
    }
  }

  const main = rawByRole.get("main");
  const pro = rawByRole.get("pro");
  const contra = rawByRole.get("contra");
  if (!main || !pro || !contra) return { name: "research_raw", status: "fail", detail: "expected main/pro/contra raw outputs" };

  try {
    const prompts = parseResearchPrompts(main.rawOutput);
    if (prompts.proPrompt !== response.proPrompt || prompts.contraPrompt !== response.contraPrompt) {
      return { name: "research_raw", status: "fail", detail: "planner raw output does not reproduce research prompts" };
    }
  } catch (e) {
    return { name: "research_raw", status: "fail", detail: `planner raw output parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (pro.rawOutput !== response.proAnalysis) return { name: "research_raw", status: "fail", detail: "pro raw output mismatch" };
  if (contra.rawOutput !== response.contraAnalysis) return { name: "research_raw", status: "fail", detail: "contra raw output mismatch" };

  return { name: "research_raw", status: "pass", detail: `${raw.agentOutputs.length} raw research outputs verified` };
}

function hasResearchRoles(items: Array<{ role: string }>): boolean {
  return items.map((item) => item.role).join(",") === "main,pro,contra";
}

async function verifyProvenance(deployment: Manifest["deployment"], opts: VerifyOptions): Promise<CheckResult> {
  if (deployment.environment === "local") return { name: "provenance", status: "skip", detail: "local deployment" };
  if (!opts.provenance) return { name: "provenance", status: "skip", detail: "no provenance checker configured" };
  try {
    return matchProvenance(deployment, await opts.provenance(deployment));
  } catch (e) {
    return { name: "provenance", status: "fail", detail: e instanceof Error ? e.message : String(e) };
  }
}

async function verifyResearchArticle(m: NewsResearchManifest, opts: VerifyOptions): Promise<CheckResult> {
  if (!opts.refetchInputs) return { name: "inputs", status: "skip", detail: "refetchInputs disabled" };
  if (m.article.error !== null || m.article.contentSha256 === null) return { name: "inputs", status: "skip", detail: "article was not fetchable" };
  const fetcher = opts.fetchUrl ?? defaultFetchUrl;
  const r = await fetcher(m.article.url);
  if (r.error) return { name: "inputs", status: "fail", detail: `article refetch failed: ${r.error}` };
  if (r.contentSha256 === m.article.contentSha256) return { name: "inputs", status: "pass", detail: "article content hash matches" };
  return { name: "inputs", status: "fail", detail: "article content drifted or was tampered" };
}

async function verifyInputs(m: SynthesizeResponse["manifest"], opts: VerifyOptions): Promise<CheckResult> {
  if (!opts.refetchInputs) return { name: "inputs", status: "skip", detail: "refetchInputs disabled" };
  const fetcher = opts.fetchUrl ?? defaultFetchUrl;
  let mismatches = 0;
  let checked = 0;
  for (const input of m.inputs) {
    if (input.kind !== "url" || !input.url || input.error !== null || input.contentSha256 === null) continue;
    checked++;
    const r = await fetcher(input.url);
    if (r.error || r.contentSha256 !== input.contentSha256) mismatches++;
  }
  if (checked === 0) return { name: "inputs", status: "skip", detail: "no fetchable url inputs" };
  if (mismatches === 0) return { name: "inputs", status: "pass", detail: `${checked} url inputs match` };
  return { name: "inputs", status: "fail", detail: `${mismatches}/${checked} url inputs drifted or tampered` };
}

function verifyMerge(m: SynthesizeResponse["manifest"], raw: SynthesizeResponse["raw"]): CheckResult {
  if (!raw || raw.length === 0) return { name: "merge", status: "skip", detail: "no raw outputs in response" };

  const successfulModels = new Set(m.models.filter((mm) => mm.status === "ok").map((mm) => providerModelKey(mm)));
  const consensusInput: ConsensusInput = [];
  for (const r of raw) {
    const pm = providerModelKey(r);
    if (!successfulModels.has(pm)) continue;
    try {
      const parsed = parseStructuredOutput(r.rawOutput);
      consensusInput.push({ providerModel: pm, claims: parsed.claims });
    } catch (e) {
      return { name: "merge", status: "fail", detail: `failed to parse raw output for ${pm}: ${e instanceof Error ? e.message : e}` };
    }
  }
  const merged = consensus(consensusInput);
  if (canonicalEquals(merged.claims, m.merge.claims) && canonicalEquals(merged.minorityClaims, m.merge.minorityClaims)) {
    return { name: "merge", status: "pass", detail: `${merged.claims.length} consensus + ${merged.minorityClaims.length} minority reproduced` };
  }
  return { name: "merge", status: "fail", detail: "re-run merge does not match manifest" };
}

function canonicalEquals(a: unknown, b: unknown): boolean {
  return sha256OfCanonical(a) === sha256OfCanonical(b);
}

export function isAllPass(results: CheckResult[]): boolean {
  return results.every((r) => r.status !== "fail");
}

export function isStrictPass(results: CheckResult[]): boolean {
  return results.every((r) => r.status === "pass");
}
