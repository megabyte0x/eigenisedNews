import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import type { Sha256 } from "../lib/hash";

export async function signManifestSha256(privateKey: `0x${string}`, manifestSha256: Sha256): Promise<`0x${string}`> {
  const account = privateKeyToAccount(privateKey);
  return account.signMessage({ message: manifestSha256 });
}

export async function recoverManifestSigner(manifestSha256: Sha256, signature: `0x${string}`): Promise<string> {
  const addr = await recoverMessageAddress({ message: manifestSha256, signature });
  return addr.toLowerCase();
}
