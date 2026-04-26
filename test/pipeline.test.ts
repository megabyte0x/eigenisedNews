import { describe, test, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { runSynthesis, type RunSynthesisDeps } from "../src/pipeline";
import { recoverManifestSigner } from "../src/manifest/sign";
import { canonicalize } from "../src/lib/canonicalize";
import { sha256OfBytes } from "../src/lib/hash";
import type { SynthesizeRequest } from "../src/types";

const FIXED_TS = "2026-04-27T12:00:00.000Z";

function makeDeps(overrides: Partial<RunSynthesisDeps> = {}): RunSynthesisDeps {
  const pk = generatePrivateKey();
  return {
    fetchUrl: async (url) => ({
      kind: "url",
      url,
      contentSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      text: `body of ${url}`,
      fetchedAt: FIXED_TS,
      byteLength: 11 + url.length,
      error: null,
    }),
    callModel: async ({ provider, model }) => ({
      rawOutput: JSON.stringify({
        claims: [{ statement: "the sky is blue", supportingSourceIndices: [0] }],
        summary: `summary from ${provider}/${model}`,
      }),
      latencyMs: 10,
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
}

describe("runSynthesis", () => {
  test("validation: missing topic", async () => {
    const r = await runSynthesis(makeDeps(), { topic: "", urls: ["https://x"] });
    expect(r.status).toBe("validation_error");
    expect(r.manifest).toBeNull();
  });

  test("validation: neither urls nor sources", async () => {
    const r = await runSynthesis(makeDeps(), { topic: "t" } as SynthesizeRequest);
    expect(r.status).toBe("validation_error");
  });

  test("happy path: 4 models all agree → 1 consensus claim, signature recovers", async () => {
    const deps = makeDeps();
    const r = await runSynthesis(deps, { topic: "t", sources: [{ text: "src" }] });
    expect(r.status).toBe("ok");
    const m = r.manifest!;
    expect(m.merge.thresholdMet).toBe(true);
    expect(m.merge.successfulModels).toBe(4);
    expect(m.merge.totalModels).toBe(4);
    expect(m.merge.claims).toHaveLength(1);
    expect(m.merge.claims[0].supportingModels).toHaveLength(4);
    expect(m.merge.minorityClaims).toEqual([]);
    expect(m.brief).toContain("Consensus");
    const recovered = await recoverManifestSigner(m.manifestSha256, r.signature!);
    expect(recovered.toLowerCase()).toBe(deps.deployment.agentAddress.toLowerCase());
  });

  test("mixed: 3 agree on A, 1 unique B → 1 consensus + 1 minority", async () => {
    const oddModel = "xai/grok-4";
    const deps = makeDeps({
      callModel: async ({ provider, model }) => {
        const pm = `${provider}/${model}`;
        const statement = pm === oddModel ? "the sea is salty" : "the sky is blue";
        return {
          rawOutput: JSON.stringify({ claims: [{ statement, supportingSourceIndices: [0] }], summary: pm }),
          latencyMs: 5,
        };
      },
    });
    const r = await runSynthesis(deps, { topic: "t", sources: [{ text: "src" }] });
    expect(r.status).toBe("ok");
    const m = r.manifest!;
    expect(m.merge.claims).toHaveLength(1);
    expect(m.merge.claims[0].statement).toBe("the sky is blue");
    expect(m.merge.minorityClaims).toHaveLength(1);
    expect(m.merge.minorityClaims[0].statement).toBe("the sea is salty");
  });

  test("source fetch failure on 1 of 3 → input recorded, synthesis proceeds", async () => {
    const deps = makeDeps({
      fetchUrl: async (url) =>
        url.includes("fail")
          ? { kind: "url", url, contentSha256: null, text: "", fetchedAt: FIXED_TS, byteLength: 0, error: "http_500" }
          : {
              kind: "url",
              url,
              contentSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
              text: `body of ${url}`,
              fetchedAt: FIXED_TS,
              byteLength: 16,
              error: null,
            },
    });
    const r = await runSynthesis(deps, { topic: "t", urls: ["https://a", "https://fail", "https://c"] });
    expect(r.status).toBe("ok");
    const m = r.manifest!;
    expect(m.inputs).toHaveLength(3);
    expect(m.inputs[1].error).toBe("http_500");
    expect(m.inputs[1].contentSha256).toBeNull();
    expect(m.inputs[0].error).toBeNull();
    expect(m.inputs[2].error).toBeNull();
  });

  test("2 of 4 models error → thresholdMet=false, status=threshold_not_met", async () => {
    let calls = 0;
    const deps = makeDeps({
      callModel: async () => {
        calls++;
        if (calls <= 2) throw new Error("upstream_5xx_after_retries");
        return {
          rawOutput: JSON.stringify({ claims: [{ statement: "x", supportingSourceIndices: [] }], summary: "s" }),
          latencyMs: 5,
        };
      },
    });
    const r = await runSynthesis(deps, { topic: "t", sources: [{ text: "src" }] });
    expect(r.status).toBe("threshold_not_met");
    const m = r.manifest!;
    expect(m.merge.thresholdMet).toBe(false);
    expect(m.merge.successfulModels).toBe(2);
    expect(m.merge.totalModels).toBe(4);
    expect(m.merge.claims).toEqual([]);
    expect(m.merge.minorityClaims).toEqual([]);
    expect(m.brief).toBe("");
    // Even failure manifests are signed.
    const recovered = await recoverManifestSigner(m.manifestSha256, r.signature!);
    expect(recovered.toLowerCase()).toBe(deps.deployment.agentAddress.toLowerCase());
  });

  test("requestHash equals sha256 of canonicalized request body", async () => {
    const deps = makeDeps();
    const req: SynthesizeRequest = { topic: "t", sources: [{ text: "src" }] };
    const r = await runSynthesis(deps, req);
    expect(r.status).toBe("ok");
    const expected = sha256OfBytes(canonicalize(req));
    expect(r.manifest!.request.requestHash).toBe(expected);
  });

  test("models[].promptHash is set per model and identical for identical prompts", async () => {
    const deps = makeDeps();
    const r = await runSynthesis(deps, { topic: "t", sources: [{ text: "src" }] });
    const hashes = new Set(r.manifest!.models.map((m) => m.promptHash));
    expect(hashes.size).toBe(1);
  });

  test("raw outputs returned for each successful model", async () => {
    const deps = makeDeps();
    const r = await runSynthesis(deps, { topic: "t", sources: [{ text: "src" }] });
    expect(r.raw).toHaveLength(4);
    expect(r.raw[0].rawOutput).toContain("claims");
  });

  test("manifestSha256 is deterministic across runs with identical deps", async () => {
    const pk = generatePrivateKey();
    const baseDeps = (): RunSynthesisDeps => ({
      ...makeDeps(),
      signerPrivateKey: pk,
      deployment: {
        appId: "0xapp",
        agentAddress: privateKeyToAccount(pk).address,
        imageDigest: "sha256:img",
        commitSha: "abc",
        environment: "local",
      },
    });
    const req: SynthesizeRequest = { topic: "t", sources: [{ text: "src" }] };
    const a = await runSynthesis(baseDeps(), req);
    const b = await runSynthesis(baseDeps(), req);
    expect(a.manifest!.manifestSha256).toBe(b.manifest!.manifestSha256);
  });
});
