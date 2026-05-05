import { describe, test, expect, beforeAll } from "vitest";
import { verifyResponse, isAllPass, isStrictPass } from "../src/verifier/verify";
import type { SynthesizeResponse } from "../src/types";
import { FIXED_TS, clone, makeGoodResponse } from "./helpers/verifierFixture";

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
});

describe("verifyResponse — tampered fixtures", () => {
  test("schema check fails instead of throwing on malformed response", async () => {
    const results = await verifyResponse({} as any);
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
    // Recompute the hash so manifest_hash passes
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
    // Replace one model's output with a different claim → re-run merge will produce a different result
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
});
