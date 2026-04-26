import { describe, test, expect, beforeAll } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { runSynthesis, type RunSynthesisDeps } from "../src/pipeline";
import { verifyResponse, isAllPass } from "../src/verifier/verify";
import type { SynthesizeResponse } from "../src/types";

const FIXED_TS = "2026-04-27T12:00:00.000Z";

let goodResponse: SynthesizeResponse;

beforeAll(async () => {
  const pk = generatePrivateKey();
  const deps: RunSynthesisDeps = {
    fetchUrl: async (url) => ({
      kind: "url",
      url,
      contentSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      text: `body of ${url}`,
      fetchedAt: FIXED_TS,
      byteLength: 16,
      error: null,
    }),
    callModel: async ({ provider, model }) => ({
      rawOutput: JSON.stringify({
        claims: [{ statement: "the sky is blue", supportingSourceIndices: [0] }],
        summary: `${provider}/${model}`,
      }),
      latencyMs: 5,
    }),
    now: () => FIXED_TS,
    deployment: {
      appId: "0xapp",
      agentAddress: privateKeyToAccount(pk).address,
      imageDigest: "sha256:img",
      commitSha: "abc",
      environment: "local",
    },
    signerPrivateKey: pk,
  };
  const r = await runSynthesis(deps, { topic: "t", sources: [{ text: "src" }] });
  if (r.status !== "ok") throw new Error("setup: synthesis did not succeed");
  goodResponse = { manifest: r.manifest, signature: r.signature, raw: r.raw };
});

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("verifyResponse — good fixture", () => {
  test("all runnable checks pass", async () => {
    const results = await verifyResponse(goodResponse);
    expect(isAllPass(results)).toBe(true);
    expect(results.find((r) => r.name === "manifest_hash")?.status).toBe("pass");
    expect(results.find((r) => r.name === "signature")?.status).toBe("pass");
    expect(results.find((r) => r.name === "merge")?.status).toBe("pass");
  });
});

describe("verifyResponse — tampered fixtures", () => {
  test("tampered claim fails manifest_hash check", async () => {
    const tampered = clone(goodResponse);
    tampered.manifest.merge.claims[0].statement = "the sky is green";
    const results = await verifyResponse(tampered);
    expect(results.find((r) => r.name === "manifest_hash")?.status).toBe("fail");
    expect(isAllPass(results)).toBe(false);
  });

  test("tampered input contentSha256 fails manifest_hash check", async () => {
    const tampered = clone(goodResponse);
    tampered.manifest.inputs[0].contentSha256 = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const results = await verifyResponse(tampered);
    expect(results.find((r) => r.name === "manifest_hash")?.status).toBe("fail");
  });

  test("tampered model status fails manifest_hash check", async () => {
    const tampered = clone(goodResponse);
    tampered.manifest.models[0].status = "error";
    const results = await verifyResponse(tampered);
    expect(results.find((r) => r.name === "manifest_hash")?.status).toBe("fail");
  });

  test("tampered manifestSha256 (claims hash matches recomputed but signature won't recover) fails signature check", async () => {
    const tampered = clone(goodResponse);
    // Edit a non-hashed-into-itself field, then recompute hash to make hash check pass — but signature was over old hash, so recovery fails.
    tampered.manifest.brief = "tampered brief";
    // Recompute the hash so manifest_hash passes
    const { recomputeManifestHash } = await import("../src/verifier/verify");
    tampered.manifest.manifestSha256 = recomputeManifestHash(tampered.manifest);
    const results = await verifyResponse(tampered);
    expect(results.find((r) => r.name === "manifest_hash")?.status).toBe("pass");
    expect(results.find((r) => r.name === "signature")?.status).toBe("fail");
  });

  test("tampered raw model output fails merge check", async () => {
    const tampered = clone(goodResponse);
    if (!tampered.raw || tampered.raw.length === 0) throw new Error("expected raw");
    // Replace one model's output with a different claim → re-run merge will produce a different result
    tampered.raw[0].rawOutput = JSON.stringify({
      claims: [{ statement: "completely different", supportingSourceIndices: [0] }],
      summary: "x",
    });
    const results = await verifyResponse(tampered);
    expect(results.find((r) => r.name === "merge")?.status).toBe("fail");
  });

  test("inputs re-fetch detects content drift", async () => {
    const goodWithUrl: SynthesizeResponse = clone(goodResponse);
    // Synthesize an input record with a URL kind so the verifier has something to refetch
    goodWithUrl.manifest.inputs.push({
      index: 1,
      kind: "url",
      url: "https://example.test/page",
      contentSha256: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      fetchedAt: FIXED_TS,
      byteLength: 100,
      error: null,
    });

    const results = await verifyResponse(goodWithUrl, {
      refetchInputs: true,
      fetchUrl: async (url) => ({
        kind: "url",
        url,
        contentSha256: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        text: "drifted",
        fetchedAt: FIXED_TS,
        byteLength: 7,
        error: null,
      }),
    });
    expect(results.find((r) => r.name === "inputs")?.status).toBe("fail");
  });
});
