import type { Manifest, NewsResearchManifest } from "../types";
import { sha256OfCanonical } from "../lib/canonicalHash";
import type { Sha256 } from "../lib/hash";
import { POLICY } from "../lib/policy";

export type BuildManifestInput = Omit<Manifest, "schemaVersion" | "rulesetVersion" | "manifestSha256">;
export type BuildResearchManifestInput = Omit<NewsResearchManifest, "schemaVersion" | "rulesetVersion" | "kind" | "manifestSha256">;

const PLACEHOLDER_SHA256: Sha256 = "sha256:";

export function hashManifestWithPlaceholder(m: Manifest): Sha256 {
  return sha256OfCanonical({ ...m, manifestSha256: PLACEHOLDER_SHA256 });
}

export function hashResearchManifestWithPlaceholder(m: NewsResearchManifest): Sha256 {
  return sha256OfCanonical({ ...m, manifestSha256: PLACEHOLDER_SHA256 });
}

export function buildManifest(input: BuildManifestInput): Manifest {
  const withPlaceholder: Manifest = {
    schemaVersion: POLICY.SCHEMA_VERSION,
    rulesetVersion: POLICY.RULESET_VERSION,
    ...input,
    manifestSha256: PLACEHOLDER_SHA256,
  };
  withPlaceholder.manifestSha256 = sha256OfCanonical(withPlaceholder);
  return withPlaceholder;
}

export function buildResearchManifest(input: BuildResearchManifestInput): NewsResearchManifest {
  const withPlaceholder: NewsResearchManifest = {
    schemaVersion: POLICY.SCHEMA_VERSION,
    rulesetVersion: POLICY.RULESET_VERSION,
    kind: "research",
    ...input,
    manifestSha256: PLACEHOLDER_SHA256,
  };
  withPlaceholder.manifestSha256 = sha256OfCanonical(withPlaceholder);
  return withPlaceholder;
}
