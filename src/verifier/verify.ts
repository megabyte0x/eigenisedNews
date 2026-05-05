import type { InputRecord, Manifest, ModelRun, RawModelOutput, SynthesizeResponse } from "../types";
import { sha256Hex } from "../lib/hash";
import { sha256OfCanonical } from "../lib/canonicalHash";
import { providerModelKey } from "../lib/policy";
import { isUnknownRecord, type UnknownRecord } from "../lib/guards";
import { hashManifestWithPlaceholder } from "../manifest/build";
import { recoverManifestSigner } from "../manifest/sign";
import { parseStructuredOutput } from "../fanout/llmProxy";
import { consensus, type ConsensusInput } from "../merger/consensus";
import { fetchUrl as defaultFetchUrl, type FetchUrlResult } from "../fetchers/sourceFetcher";
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
  const typedResponse = parsed.response;
  const m = typedResponse.manifest;

  const recomputed = hashManifestWithPlaceholder(m);
  out.push(
    recomputed === m.manifestSha256
      ? { name: "manifest_hash", status: "pass", detail: m.manifestSha256 }
      : { name: "manifest_hash", status: "fail", detail: `recomputed ${recomputed} != claimed ${m.manifestSha256}` }
  );

  try {
    const recovered = await recoverManifestSigner(m.manifestSha256, typedResponse.signature);
    out.push(
      recovered.toLowerCase() === m.deployment.agentAddress.toLowerCase()
        ? { name: "signature", status: "pass", detail: `recovered ${recovered}` }
        : { name: "signature", status: "fail", detail: `recovered ${recovered} != claimed ${m.deployment.agentAddress}` }
    );
  } catch (e) {
    out.push({ name: "signature", status: "fail", detail: e instanceof Error ? e.message : String(e) });
  }

  out.push(await verifyInputs(m, opts));
  const rawCheck = verifyRawOutputs(m, typedResponse.raw);
  out.push(rawCheck);
  out.push(rawCheck.status === "fail" ? { name: "merge", status: "skip", detail: "raw_outputs failed" } : verifyMerge(m, typedResponse.raw));
  out.push(await verifyProvenance(m, opts));

  return out;
}

type ParsedResponse = { ok: true; schema: CheckResult; response: SynthesizeResponse } | { ok: false; schema: CheckResult };

function parseResponse(response: unknown): ParsedResponse {
  if (!isUnknownRecord(response)) return { ok: false, schema: { name: "schema", status: "fail", detail: "response is not an object" } };
  if (!isManifest(response.manifest)) return { ok: false, schema: { name: "schema", status: "fail", detail: "manifest missing or malformed" } };
  if (typeof response.signature !== "string" || !response.signature.startsWith("0x")) {
    return { ok: false, schema: { name: "schema", status: "fail", detail: "signature missing or invalid" } };
  }
  if (response.raw !== null && (!Array.isArray(response.raw) || !response.raw.every(isRawModelOutput))) {
    return { ok: false, schema: { name: "schema", status: "fail", detail: "raw must be null or an array of raw model outputs" } };
  }
  return {
    ok: true,
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
  return value === "sepolia" || value === "mainnet-alpha" || value === "local";
}

function isRequestRecord(value: unknown): value is Manifest["request"] {
  return isUnknownRecord(value) && typeof value.topic === "string" && typeof value.requestHash === "string";
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

async function verifyProvenance(m: SynthesizeResponse["manifest"], opts: VerifyOptions): Promise<CheckResult> {
  if (m.deployment.environment === "local") return { name: "provenance", status: "skip", detail: "local deployment" };
  if (!opts.provenance) return { name: "provenance", status: "skip", detail: "no provenance checker configured" };
  try {
    return matchProvenance(m.deployment, await opts.provenance(m.deployment));
  } catch (e) {
    return { name: "provenance", status: "fail", detail: e instanceof Error ? e.message : String(e) };
  }
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
