import { describe, test, expect } from "vitest";
import request from "supertest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../src/index";
import type { RunSynthesisDeps } from "../src/pipeline";

const FIXED_TS = "2026-04-27T12:00:00.000Z";

function makeApp(overrides: Partial<RunSynthesisDeps> = {}) {
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
    ...overrides,
  };
  return buildApp(deps);
}

describe("POST /synthesize", () => {
  test("happy path: 200 with manifest, signature, raw=null by default", async () => {
    const res = await request(makeApp()).post("/synthesize").send({ topic: "t", sources: [{ text: "x" }] });
    expect(res.status).toBe(200);
    expect(res.body.manifest).toBeDefined();
    expect(res.body.manifest.merge.thresholdMet).toBe(true);
    expect(res.body.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(res.body.raw).toBeNull();
  });

  test("?include=raw populates raw", async () => {
    const res = await request(makeApp())
      .post("/synthesize")
      .query({ include: "raw" })
      .send({ topic: "t", sources: [{ text: "x" }] });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.raw)).toBe(true);
    expect(res.body.raw.length).toBe(4);
  });

  test("400 on missing topic", async () => {
    const res = await request(makeApp()).post("/synthesize").send({ sources: [{ text: "x" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("topic_required");
  });

  test("400 on neither urls nor sources", async () => {
    const res = await request(makeApp()).post("/synthesize").send({ topic: "t" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_inputs");
  });

  test("400 on empty body", async () => {
    const res = await request(makeApp()).post("/synthesize").send({});
    expect(res.status).toBe(400);
  });

  test("503 with signed partial manifest when threshold not met", async () => {
    let calls = 0;
    const res = await request(
      makeApp({
        callModel: async () => {
          calls++;
          if (calls <= 2) throw new Error("upstream_5xx_after_retries");
          return {
            rawOutput: JSON.stringify({ claims: [{ statement: "x", supportingSourceIndices: [] }], summary: "s" }),
            latencyMs: 5,
          };
        },
      })
    )
      .post("/synthesize")
      .send({ topic: "t", sources: [{ text: "x" }] });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("min_model_success_not_met");
    expect(res.body.manifest.merge.thresholdMet).toBe(false);
    expect(res.body.signature).toMatch(/^0x[0-9a-f]+$/i);
  });
});
