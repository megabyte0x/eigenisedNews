import type {
  InputRecord,
  Manifest,
  ModelRun,
  NewsResearchAgentRun,
  NewsResearchManifest,
  NewsResearchPromptBinding,
  NewsResearchRaw,
  NewsResearchRawAgentOutput,
  NewsResearchResponse,
  RawModelOutput,
  SynthesizeResponse,
} from "../types";
import { sha256Hex } from "../lib/hash";
import { sha256OfCanonical } from "../lib/canonicalHash";
import { providerModelKey } from "../lib/policy";
import { isUnknownRecord, type UnknownRecord } from "../lib/guards";
import { hashManifestWithPlaceholder, hashResearchManifestWithPlaceholder } from "../manifest/build";
import { recoverManifestSigner } from "../manifest/sign";
import { parseStructuredOutput } from "../fanout/llmProxy";
import { consensus, type ConsensusInput } from "../merger/consensus";
import { fetchUrl as defaultFetchUrl, type FetchUrlResult } from "../fetchers/sourceFetcher";
import { composeResearchSummary, parseResearchPrompts } from "../pipeline";
import { matchProvenance, type ProvenanceChecker } from "./provenance";
import type { CheckResult } from "./types";

export type { CheckResult, CheckStatus } from "./types";

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
    if (typeof response.signature !== "string" || !response.signature.startsWith("0x")) {
      return { ok: false, schema: { name: "schema", status: "fail", detail: "signature missing or invalid" } };
    }
    if (response.raw !== null && !isNewsResearchRaw(response.raw)) {
      return { ok: false, schema: { name: "schema", status: "fail", detail: "research raw must be null or a research raw object" } };
    }
    if (!isNewsResearchResponseBody(response)) {
      return { ok: false, schema: { name: "schema", status: "fail", detail: "research response missing or malformed" } };
    }
    return {
      ok: true,
      kind: "research",
      schema: { name: "schema", status: "pass", detail: "research response shape is valid" },
      response: response as NewsResearchResponse,
    };
  }
  if (!isManifest(response.manifest)) return { ok: false, schema: { name: "schema", status: "fail", detail: "manifest missing or malformed" } };
  if (typeof response.signature !== "string" || !response.signature.startsWith("0x")) {
    return { ok: false, schema: { name: "schema", status: "fail", detail: "signature missing or invalid" } };
  }
  if (response.raw !== null && (!Array.isArray(response.raw) || !response.raw.every(isRawModelOutput))) {
    return { ok: false, schema: { name: "schema", status: "fail", detail: "raw must be null or an array of raw model outputs" } };
  }
  return {
    ok: true,
    kind: "synthesize",
    schema: { name: "schema", status: "pass", detail: "response shape is valid" },
    response: { manifest: response.manifest, signature: response.signature as `0x${string}`, raw: response.raw },
  };
}

function isManifest(value: unknown): value is Manifest {
  if (!isUnknownRecord(value)) return false;
  return (
    value.schemaVersion === "1" &&
    typeof value.rulesetVersion === "string" &&
    isDeployment(value.deployment) &&
    isRequestRecord(value.request) &&
    Array.isArray(value.inputs) &&
    value.inputs.every(isInputRecord) &&
    Array.isArray(value.models) &&
    value.models.every(isModelRun) &&
    isMerge(value.merge) &&
    typeof value.brief === "string" &&
    typeof value.briefSha256 === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.manifestSha256 === "string"
  );
}

function isResearchManifest(value: unknown): value is NewsResearchManifest {
  if (!isUnknownRecord(value)) return false;
  return (
    value.schemaVersion === "1" &&
    typeof value.rulesetVersion === "string" &&
    value.kind === "research" &&
    isDeployment(value.deployment) &&
    isResearchRequestRecord(value.request) &&
    isNewsResearchArticle(value.article) &&
    Array.isArray(value.promptBindings) &&
    value.promptBindings.every(isNewsResearchPromptBinding) &&
    Array.isArray(value.agentRuns) &&
    value.agentRuns.every(isNewsResearchAgentRun) &&
    isNewsResearchOutputHashes(value.outputs) &&
    typeof value.timestamp === "string" &&
    typeof value.manifestSha256 === "string"
  );
}

function isDeployment(value: unknown): value is Manifest["deployment"] {
  return (
    isUnknownRecord(value) &&
    typeof value.appId === "string" &&
    typeof value.agentAddress === "string" &&
    typeof value.imageDigest === "string" &&
    typeof value.commitSha === "string" &&
    isDeploymentEnvironment(value.environment)
  );
}

function isDeploymentEnvironment(value: unknown): value is Manifest["deployment"]["environment"] {
  return value === "mainnet-alpha" || value === "local";
}

function isRequestRecord(value: unknown): value is Manifest["request"] {
  return isUnknownRecord(value) && typeof value.topic === "string" && typeof value.requestHash === "string";
}

function isResearchRequestRecord(value: unknown): value is NewsResearchManifest["request"] {
  return isUnknownRecord(value) && typeof value.articleUrl === "string" && typeof value.requestHash === "string";
}

function isInputRecord(value: unknown): value is InputRecord {
  return (
    isUnknownRecord(value) &&
    typeof value.index === "number" &&
    (value.kind === "url" || value.kind === "text") &&
    optionalString(value, "url") &&
    (typeof value.contentSha256 === "string" || value.contentSha256 === null) &&
    optionalString(value, "fetchedAt") &&
    typeof value.byteLength === "number" &&
    (typeof value.error === "string" || value.error === null)
  );
}

function isNewsResearchResponseBody(value: UnknownRecord): value is NewsResearchResponse {
  return (
    isNewsResearchArticle(value.article) &&
    typeof value.proPrompt === "string" &&
    typeof value.contraPrompt === "string" &&
    typeof value.proAnalysis === "string" &&
    typeof value.contraAnalysis === "string" &&
    typeof value.mainSummary === "string" &&
    Array.isArray(value.promptBindings) &&
    value.promptBindings.every(isNewsResearchPromptBinding) &&
    isNewsResearchVerifiableBuild(value.verifiableBuild) &&
    Array.isArray(value.agentRuns) &&
    value.agentRuns.every(isNewsResearchAgentRun)
  );
}

function isNewsResearchArticle(value: unknown): value is NewsResearchResponse["article"] {
  return (
    isUnknownRecord(value) &&
    typeof value.url === "string" &&
    (typeof value.contentSha256 === "string" || value.contentSha256 === null) &&
    optionalString(value, "fetchedAt") &&
    typeof value.byteLength === "number" &&
    (typeof value.error === "string" || value.error === null)
  );
}

function isNewsResearchPromptBinding(value: unknown): value is NewsResearchPromptBinding {
  return (
    isUnknownRecord(value) &&
    isNewsResearchAgentRole(value.role) &&
    (value.perspective === "planner" || value.perspective === "supports_article" || value.perspective === "challenges_article") &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    typeof value.systemPrompt === "string" &&
    typeof value.systemPromptSha256 === "string" &&
    typeof value.promptHash === "string" &&
    typeof value.articleUrl === "string" &&
    (typeof value.articleContentSha256 === "string" || value.articleContentSha256 === null) &&
    (typeof value.researchPrompt === "string" || value.researchPrompt === null)
  );
}

function isNewsResearchAgentRun(value: unknown): value is NewsResearchAgentRun {
  return (
    isUnknownRecord(value) &&
    isNewsResearchAgentRole(value.role) &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    (value.status === "ok" || value.status === "error") &&
    typeof value.promptHash === "string" &&
    (typeof value.rawOutputSha256 === "string" || value.rawOutputSha256 === null) &&
    (typeof value.error === "string" || value.error === null)
  );
}

function isNewsResearchVerifiableBuild(value: unknown): value is NewsResearchResponse["verifiableBuild"] {
  if (!isUnknownRecord(value)) return false;
  const record = value;
  if (!isDeployment(record as unknown)) return false;
  return (
    (typeof record.dashboardUrl === "string" || record.dashboardUrl === null) &&
    typeof record.promptSourcePath === "string" &&
    (typeof record.promptSourceUrl === "string" || record.promptSourceUrl === null)
  );
}

function isNewsResearchOutputHashes(value: unknown): value is NewsResearchManifest["outputs"] {
  return (
    isUnknownRecord(value) &&
    typeof value.proPromptSha256 === "string" &&
    typeof value.contraPromptSha256 === "string" &&
    typeof value.proAnalysisSha256 === "string" &&
    typeof value.contraAnalysisSha256 === "string" &&
    typeof value.mainSummarySha256 === "string" &&
    value.summaryAlgorithm === "composeResearchSummary/v1"
  );
}

function isNewsResearchRaw(value: unknown): value is NewsResearchRaw {
  return (
    isUnknownRecord(value) &&
    Array.isArray(value.agentOutputs) &&
    value.agentOutputs.every(isNewsResearchRawAgentOutput) &&
    typeof value.mainSummary === "string"
  );
}

function isNewsResearchRawAgentOutput(value: unknown): value is NewsResearchRawAgentOutput {
  return (
    isUnknownRecord(value) &&
    isNewsResearchAgentRole(value.role) &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    typeof value.prompt === "string" &&
    typeof value.rawOutput === "string"
  );
}

function isNewsResearchAgentRole(value: unknown): value is NewsResearchAgentRun["role"] {
  return value === "main" || value === "pro" || value === "contra";
}

function isModelRun(value: unknown): value is ModelRun {
  return (
    isUnknownRecord(value) &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    typeof value.version === "string" &&
    typeof value.promptHash === "string" &&
    (value.status === "ok" || value.status === "error") &&
    (typeof value.rawOutputSha256 === "string" || value.rawOutputSha256 === null) &&
    typeof value.parsedClaimCount === "number" &&
    (typeof value.error === "string" || value.error === null)
  );
}

function isMerge(value: unknown): value is Manifest["merge"] {
  return (
    isUnknownRecord(value) &&
    typeof value.successfulModels === "number" &&
    typeof value.totalModels === "number" &&
    typeof value.thresholdMet === "boolean" &&
    typeof value.consensusThreshold === "string" &&
    Array.isArray(value.claims) &&
    value.claims.every(isClaim) &&
    Array.isArray(value.minorityClaims) &&
    value.minorityClaims.every(isClaim)
  );
}

function isClaim(value: unknown): value is Manifest["merge"]["claims"][number] {
  return (
    isUnknownRecord(value) &&
    typeof value.id === "string" &&
    typeof value.statement === "string" &&
    stringArray(value.supportingModels) &&
    numberArray(value.supportingSourceIndices)
  );
}

function isRawModelOutput(value: unknown): value is RawModelOutput {
  return isUnknownRecord(value) && typeof value.provider === "string" && typeof value.model === "string" && typeof value.rawOutput === "string";
}

function optionalString(value: UnknownRecord, key: string): boolean {
  return !(key in value) || value[key] === undefined || typeof value[key] === "string";
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function numberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
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
  const eq = (a: unknown, b: unknown) => sha256OfCanonical(a) === sha256OfCanonical(b);

  if (!eq(response.article, m.article)) mismatches.push("article");
  if (!eq(response.promptBindings, m.promptBindings)) mismatches.push("promptBindings");
  if (!eq(response.agentRuns, m.agentRuns)) mismatches.push("agentRuns");
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
  const eq = (a: unknown, b: unknown) => sha256OfCanonical(a) === sha256OfCanonical(b);
  if (eq(merged.claims, m.merge.claims) && eq(merged.minorityClaims, m.merge.minorityClaims)) {
    return { name: "merge", status: "pass", detail: `${merged.claims.length} consensus + ${merged.minorityClaims.length} minority reproduced` };
  }
  return { name: "merge", status: "fail", detail: "re-run merge does not match manifest" };
}

export function isAllPass(results: CheckResult[]): boolean {
  return results.every((r) => r.status !== "fail");
}

export function isStrictPass(results: CheckResult[]): boolean {
  return results.every((r) => r.status === "pass");
}
