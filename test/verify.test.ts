import { describe, test, expect, beforeAll } from "vitest";
import { verifyResponse, isAllPass, isStrictPass } from "../src/verifier/verify";
import type { SynthesizeResponse } from "../src/types";
import { FIXED_TS, clone, makeGoodResponse } from "./helpers/verifierFixture";
import { runSynthesis, type RunSynthesisDeps } from "../src/pipeline";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

let goodResponse: SynthesizeResponse;

beforeAll(async () => {
  goodResponse = await makeGoodResponse();
});

describe("verifier result helpers", () => {
  test("isAllPass allows skips but rejects failures", () => {
    expect(isAllPass([{ name: "x", status: "skip", detail: "offline" }])).toBe(true);
    expect(isAllPass([{ name: "x", status: "fail", detail: "bad" }])).toBe(false);
  });

  test("isStrictPass rejects skips and failures", () => {
    expect(isStrictPass([{ name: "x", status: "pass", detail: "ok" }])).toBe(true);
    expect(isStrictPass([{ name: "x", status: "skip", detail: "offline" }])).toBe(false);
    expect(isStrictPass([{ name: "x", status: "fail", detail: "bad" }])).toBe(false);
  });
});

describe("verifyResponse — good fixture", () => {
  test("schema check passes for good response", async () => {
    const results = await verifyResponse(goodResponse);
    expect(results[0]).toMatchObject({ name: "schema", status: "pass" });
  });

  test("all runnable checks pass", async () => {
    const results = await verifyResponse(goodResponse);
    expect(isAllPass(results)).toBe(true);
    expect(results.find((r) => r.name === "manifest_hash")?.status).toBe("pass");
    expect(results.find((r) => r.name === "signature")?.status).toBe("pass");
    expect(results.find((r) => r.name === "merge")?.status).toBe("pass");
  });

  test("merge skips when raw outputs are omitted", async () => {
    const response = clone(goodResponse);
    response.raw = null;
    const results = await verifyResponse(response);
    expect(results.find((r) => r.name === "raw_outputs")?.status).toBe("skip");
    expect(results.find((r) => r.name === "merge")?.status).toBe("skip");
    expect(isAllPass(results)).toBe(true);
    expect(isStrictPass(results)).toBe(false);
  });

  test("raw output verification accepts fenced JSON with runtime-matching semantics", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
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
        rawOutput: `\`\`\`json\n${JSON.stringify({
          claims: [{ statement: "the sky is blue", supportingSourceIndices: [0] }],
          summary: `${provider}/${model}`,
        })}\n\`\`\``,
        latencyMs: 5,
      }),
      now: () => FIXED_TS,
      deployment: {
        appId: "0xapp",
        agentAddress: account.address,
        imageDigest: "sha256:img",
        commitSha: "abc",
        environment: "local",
      },
      sign: (h) => account.signMessage({ message: h }),
    };

    const response = await runSynthesis(deps, { topic: "t", sources: [{ text: "src" }] });
    if (response.status !== "ok") throw new Error("setup: synthesis did not succeed");

    const results = await verifyResponse({ manifest: response.manifest, signature: response.signature, raw: response.raw });
    expect(results.find((r) => r.name === "raw_outputs")?.status).toBe("pass");
    expect(results.find((r) => r.name === "merge")?.status).toBe("pass");
    expect(isAllPass(results)).toBe(true);
  });
});

describe("verifyResponse — tampered fixtures", () => {
  test("schema check fails instead of throwing on malformed response", async () => {
    const results = await verifyResponse({});
    expect(results.find((r) => r.name === "schema")?.status).toBe("fail");
    expect(isAllPass(results)).toBe(false);
  });

  test("schema check fails instead of throwing on malformed nested manifest", async () => {
    const results = await verifyResponse({ manifest: { deployment: null }, signature: "0x1234", raw: null });
    expect(results.find((r) => r.name === "schema")?.status).toBe("fail");
    expect(isAllPass(results)).toBe(false);
  });

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
    const { hashManifestWithPlaceholder } = await import("../src/manifest/build");
    tampered.manifest.manifestSha256 = hashManifestWithPlaceholder(tampered.manifest);
    const results = await verifyResponse(tampered);
    expect(results.find((r) => r.name === "manifest_hash")?.status).toBe("pass");
    expect(results.find((r) => r.name === "signature")?.status).toBe("fail");
  });

  test("raw_outputs fails when a successful model raw output is missing", async () => {
    const tampered = clone(goodResponse);
    tampered.raw = tampered.raw!.slice(1);
    const results = await verifyResponse(tampered);
    expect(results.find((r) => r.name === "raw_outputs")?.status).toBe("fail");
  });

  test("raw_outputs fails when raw hash does not match manifest", async () => {
    const tampered = clone(goodResponse);
    tampered.raw![0].rawOutput = JSON.stringify({
      claims: [{ statement: "the sky is green", supportingSourceIndices: [0] }],
      summary: "changed",
    });
    const results = await verifyResponse(tampered);
    expect(results.find((r) => r.name === "raw_outputs")?.status).toBe("fail");
    expect(results.find((r) => r.name === "merge")?.status).toBe("skip");
  });

  test("raw_outputs fails on extra raw output from non-successful model", async () => {
    const tampered = clone(goodResponse);
    tampered.raw!.push({ provider: "extra", model: "bogus", rawOutput: "{}" });
    const results = await verifyResponse(tampered);
    expect(results.find((r) => r.name === "raw_outputs")?.status).toBe("fail");
  });

  test("tampered raw model output fails raw output check and skips merge", async () => {
    const tampered = clone(goodResponse);
    if (!tampered.raw || tampered.raw.length === 0) throw new Error("expected raw");
    tampered.raw[0].rawOutput = JSON.stringify({
      claims: [{ statement: "completely different", supportingSourceIndices: [0] }],
      summary: "x",
    });
    const results = await verifyResponse(tampered);
    expect(results.find((r) => r.name === "raw_outputs")?.status).toBe("fail");
    expect(results.find((r) => r.name === "merge")?.status).toBe("skip");
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

  test("provenance passes when injected evidence matches deployment", async () => {
    const response = clone(goodResponse);
    response.manifest.deployment = {
      ...response.manifest.deployment,
        environment: "mainnet-alpha",
      appId: "0xabc",
      imageDigest: "sha256:image",
      commitSha: "commit123",
      agentAddress: response.manifest.deployment.agentAddress,
    };

    const results = await verifyResponse(response, {
      provenance: async () => ({
        appId: "0xabc",
        imageDigests: ["sha256:image"],
        commitShas: ["commit123"],
        derivedAddresses: [response.manifest.deployment.agentAddress],
      }),
    });

    expect(results.find((r) => r.name === "provenance")?.status).toBe("pass");
  });

  test("provenance fails when image digest is absent from evidence", async () => {
    const response = clone(goodResponse);
    response.manifest.deployment = {
      ...response.manifest.deployment,
        environment: "mainnet-alpha",
      appId: "0xabc",
      imageDigest: "sha256:expected",
      commitSha: "commit123",
    };

    const results = await verifyResponse(response, {
      provenance: async () => ({
        appId: "0xabc",
        imageDigests: ["sha256:other"],
        commitShas: ["commit123"],
        derivedAddresses: [response.manifest.deployment.agentAddress],
      }),
    });

    expect(results.find((r) => r.name === "provenance")?.status).toBe("fail");
  });
});
