import type { Manifest } from "../types";
import { canonicalize } from "../lib/canonicalize";
import { sha256OfBytes, type Sha256 } from "../lib/hash";
import { POLICY } from "../lib/policy";

export type BuildManifestInput = Omit<Manifest, "schemaVersion" | "rulesetVersion" | "manifestSha256">;

const PLACEHOLDER: Sha256 = "sha256:";

export function buildManifest(input: BuildManifestInput): Manifest {
  const withPlaceholder: Manifest = {
    schemaVersion: "1",
    rulesetVersion: POLICY.RULESET_VERSION,
    ...input,
    manifestSha256: PLACEHOLDER,
  };
  const hash = sha256OfBytes(canonicalize(withPlaceholder));
  return { ...withPlaceholder, manifestSha256: hash };
}
