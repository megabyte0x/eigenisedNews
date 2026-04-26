import type { Claim } from "../types";
import { normalizeClaim } from "./normalize";

type RawClaim = {
  statement: string;
  supportingSourceIndices: number[];
};

export type ConsensusInput = {
  providerModel: string;
  claims: RawClaim[];
}[];

export type ConsensusOutput = {
  claims: Claim[];
  minorityClaims: Claim[];
};

type ClaimGroup = {
  canonical: string;
  models: Set<string>;
  sources: Set<number>;
};

export function consensus(input: ConsensusInput): ConsensusOutput {
  const n = input.length;
  if (n === 0) return { claims: [], minorityClaims: [] };

  const threshold = Math.ceil(n / 2);
  const groups = new Map<string, ClaimGroup>();

  for (const { providerModel, claims } of input) {
    const seenInThisModel = new Set<string>();
    for (const raw of claims) {
      const norm = normalizeClaim(raw.statement);
      if (!norm) continue;
      let group = groups.get(norm);
      if (!group) {
        group = { canonical: raw.statement, models: new Set(), sources: new Set() };
        groups.set(norm, group);
      } else if (raw.statement < group.canonical) {
        group.canonical = raw.statement;
      }
      // A model that emits the same claim twice still gets one vote.
      if (!seenInThisModel.has(norm)) {
        group.models.add(providerModel);
        seenInThisModel.add(norm);
      }
      for (const idx of raw.supportingSourceIndices) group.sources.add(idx);
    }
  }

  const ordered = [...groups.values()].sort((a, b) => {
    const byCount = b.models.size - a.models.size;
    if (byCount !== 0) return byCount;
    return a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0;
  });

  const consensusClaims: Claim[] = [];
  const minorityClaims: Claim[] = [];
  for (const g of ordered) {
    const bucket = g.models.size >= threshold ? consensusClaims : minorityClaims;
    bucket.push({
      id: `${g.models.size >= threshold ? "c" : "m"}${bucket.length}`,
      statement: g.canonical,
      supportingModels: [...g.models].sort(),
      supportingSourceIndices: [...g.sources].sort((a, b) => a - b),
    });
  }
  return { claims: consensusClaims, minorityClaims };
}
