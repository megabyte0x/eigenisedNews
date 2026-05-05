import { canonicalize } from "./canonicalize";
import { sha256OfBytes, type Sha256 } from "./hash";

export function sha256OfCanonical(value: unknown): Sha256 {
  return sha256OfBytes(canonicalize(value));
}
