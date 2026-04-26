import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import type { Sha256 } from "../lib/hash";

export type ManifestSigner = (manifestSha256: Sha256) => Promise<`0x${string}`>;

export function makeManifestSigner(privateKey: `0x${string}`): { sign: ManifestSigner; address: `0x${string}` } {
  const account: PrivateKeyAccount = privateKeyToAccount(privateKey);
  return {
    sign: (manifestSha256) => account.signMessage({ message: manifestSha256 }),
    address: account.address,
  };
}

export async function signManifestSha256(privateKey: `0x${string}`, manifestSha256: Sha256): Promise<`0x${string}`> {
  return makeManifestSigner(privateKey).sign(manifestSha256);
}

export async function recoverManifestSigner(manifestSha256: Sha256, signature: `0x${string}`): Promise<string> {
  const addr = await recoverMessageAddress({ message: manifestSha256, signature });
  return addr.toLowerCase();
}
