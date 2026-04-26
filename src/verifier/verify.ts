import type { SynthesizeResponse } from "../types";
import { canonicalize } from "../lib/canonicalize";
import { sha256OfBytes } from "../lib/hash";
import { providerModelKey } from "../lib/policy";
import { hashManifestWithPlaceholder } from "../manifest/build";
import { recoverManifestSigner } from "../manifest/sign";
import { parseStructuredOutput } from "../fanout/llmProxy";
import { consensus, type ConsensusInput } from "../merger/consensus";
import { fetchUrl as defaultFetchUrl, type FetchUrlResult } from "../fetchers/sourceFetcher";

export type CheckStatus = "pass" | "fail" | "skip";
export type CheckResult = { name: string; status: CheckStatus; detail: string };

export type VerifyOptions = {
  refetchInputs?: boolean;
  fetchUrl?: (url: string) => Promise<FetchUrlResult>;
  dashboardBase?: string;
};

export async function verifyResponse(response: SynthesizeResponse, opts: VerifyOptions = {}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const m = response.manifest;

  out.push({
    name: "provenance",
    status: "skip",
    detail: opts.dashboardBase ? "online provenance fetch not yet implemented" : "no dashboardBase provided (offline)",
  });

  const recomputed = hashManifestWithPlaceholder(m);
  out.push(
    recomputed === m.manifestSha256
      ? { name: "manifest_hash", status: "pass", detail: m.manifestSha256 }
      : { name: "manifest_hash", status: "fail", detail: `recomputed ${recomputed} != claimed ${m.manifestSha256}` }
  );

  try {
    const recovered = await recoverManifestSigner(m.manifestSha256, response.signature);
    out.push(
      recovered.toLowerCase() === m.deployment.agentAddress.toLowerCase()
        ? { name: "signature", status: "pass", detail: `recovered ${recovered}` }
        : { name: "signature", status: "fail", detail: `recovered ${recovered} != claimed ${m.deployment.agentAddress}` }
    );
  } catch (e) {
    out.push({ name: "signature", status: "fail", detail: e instanceof Error ? e.message : String(e) });
  }

  out.push(await verifyInputs(m, opts));
  out.push(verifyMerge(m, response.raw));

  return out;
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
  const eq = (a: unknown, b: unknown) => sha256OfBytes(canonicalize(a)) === sha256OfBytes(canonicalize(b));
  if (eq(merged.claims, m.merge.claims) && eq(merged.minorityClaims, m.merge.minorityClaims)) {
    return { name: "merge", status: "pass", detail: `${merged.claims.length} consensus + ${merged.minorityClaims.length} minority reproduced` };
  }
  return { name: "merge", status: "fail", detail: "re-run merge does not match manifest" };
}

export function isAllPass(results: CheckResult[]): boolean {
  return results.every((r) => r.status !== "fail");
}
