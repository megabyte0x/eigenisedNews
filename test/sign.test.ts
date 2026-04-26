import { describe, test, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { signManifestSha256, recoverManifestSigner } from "../src/manifest/sign";

describe("manifest signing", () => {
  test("recovers to signer address", async () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const hash = "sha256:abc" as const;
    const sig = await signManifestSha256(pk, hash);
    const recovered = await recoverManifestSigner(hash, sig);
    expect(recovered.toLowerCase()).toBe(acct.address.toLowerCase());
  });

  test("different hash produces different signature", async () => {
    const pk = generatePrivateKey();
    const a = await signManifestSha256(pk, "sha256:a");
    const b = await signManifestSha256(pk, "sha256:b");
    expect(a).not.toBe(b);
  });

  test("signature is 0x-prefixed 65-byte hex", async () => {
    const pk = generatePrivateKey();
    const sig = await signManifestSha256(pk, "sha256:test");
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/i);
  });

  test("recovering with wrong hash yields different address", async () => {
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const sig = await signManifestSha256(pk, "sha256:original");
    const recovered = await recoverManifestSigner("sha256:tampered", sig);
    expect(recovered.toLowerCase()).not.toBe(acct.address.toLowerCase());
  });
});
