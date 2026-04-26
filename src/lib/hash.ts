import { createHash } from "node:crypto";

export type Sha256 = `sha256:${string}`;

export function sha256Hex(input: string): Sha256 {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

export function sha256OfBytes(input: Uint8Array): Sha256 {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}
