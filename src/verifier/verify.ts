import type { SynthesizeResponse, Manifest } from "../types";
import { canonicalize } from "../lib/canonicalize";
import { sha256OfBytes, type Sha256 } from "../lib/hash";
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
  fetch?: typeof fetch;
};

export async function verifyResponse(response: SynthesizeResponse, opts: VerifyOptions = {}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const m = response.manifest;

  // Check 1: provenance (optional, online)
  if (opts.dashboardBase) {
    out.push({ name: "provenance", status: "skip", detail: "online provenance fetch not yet implemented" });
  } else {
    out.push({ name: "provenance", status: "skip", detail: "no dashboardBase provided (offline)" });
  }

  // Check 2a: hash recomputation
  const recomputed = recomputeManifestHash(m);
  if (recomputed !== m.manifestSha256) {
    out.push({ name: "manifest_hash", status: "fail", detail: `recomputed ${recomputed} != claimed ${m.manifestSha256}` });
  } else {
    out.push({ name: "manifest_hash", status: "pass", detail: m.manifestSha256 });
  }

  // Check 2b: signer recovery
  try {
    const recovered = await recoverManifestSigner(m.manifestSha256, response.signature);
    if (recovered.toLowerCase() === m.deployment.agentAddress.toLowerCase()) {
      out.push({ name: "signature", status: "pass", detail: `recovered ${recovered}` });
    } else {
      out.push({ name: "signature", status: "fail", detail: `recovered ${recovered} != claimed ${m.deployment.agentAddress}` });
    }
  } catch (e) {
    out.push({ name: "signature", status: "fail", detail: e instanceof Error ? e.message : String(e) });
  }

  // Check 3: inputs (re-fetch URLs)
  if (opts.refetchInputs) {
    const fetcher = opts.fetchUrl ?? defaultFetchUrl;
    let mismatches = 0;
    let checked = 0;
    for (const input of m.inputs) {
      if (input.kind !== "url" || !input.url || input.error !== null || input.contentSha256 === null) continue;
      checked++;
      const r = await fetcher(input.url);
      if (r.error || r.contentSha256 !== input.contentSha256) mismatches++;
    }
    if (checked === 0) out.push({ name: "inputs", status: "skip", detail: "no fetchable url inputs" });
    else if (mismatches === 0) out.push({ name: "inputs", status: "pass", detail: `${checked} url inputs match` });
    else out.push({ name: "inputs", status: "fail", detail: `${mismatches}/${checked} url inputs drifted or tampered` });
  } else {
    out.push({ name: "inputs", status: "skip", detail: "refetchInputs disabled" });
  }

  // Check 4: deterministic merge re-run
  if (response.raw && response.raw.length > 0) {
    const successfulModels = new Map(m.models.filter((mm) => mm.status === "ok").map((mm) => [`${mm.provider}/${mm.model}`, mm]));
    const consensusInput: ConsensusInput = [];
    for (const r of response.raw) {
      const pm = `${r.provider}/${r.model}`;
      if (!successfulModels.has(pm)) continue;
      try {
        const parsed = parseStructuredOutput(r.rawOutput);
        consensusInput.push({ providerModel: pm, claims: parsed.claims });
      } catch (e) {
        out.push({ name: "merge", status: "fail", detail: `failed to parse raw output for ${pm}: ${e instanceof Error ? e.message : e}` });
        return out;
      }
    }
    const merged = consensus(consensusInput);
    const claimsEqual = JSON.stringify(merged.claims) === JSON.stringify(m.merge.claims);
    const minorityEqual = JSON.stringify(merged.minorityClaims) === JSON.stringify(m.merge.minorityClaims);
    if (claimsEqual && minorityEqual) {
      out.push({ name: "merge", status: "pass", detail: `${merged.claims.length} consensus + ${merged.minorityClaims.length} minority reproduced` });
    } else {
      out.push({ name: "merge", status: "fail", detail: "re-run merge does not match manifest" });
    }
  } else {
    out.push({ name: "merge", status: "skip", detail: "no raw outputs in response" });
  }

  return out;
}

export function recomputeManifestHash(m: Manifest): Sha256 {
  const placeholder: Manifest = { ...m, manifestSha256: "sha256:" as Sha256 };
  return sha256OfBytes(canonicalize(placeholder));
}

export function isAllPass(results: CheckResult[]): boolean {
  return results.every((r) => r.status !== "fail");
}
