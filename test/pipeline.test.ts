import { describe, test, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { runArticleResearch, runSynthesis, type RunSynthesisDeps } from "../src/pipeline";
import { recoverManifestSigner } from "../src/manifest/sign";
import { canonicalize } from "../src/lib/canonicalize";
import { sha256OfBytes } from "../src/lib/hash";
import type { SynthesizeRequest } from "../src/types";
import { renderPrompt, renderPromptForModel } from "../src/fanout/structuredPrompt";

const FIXED_TS = "2026-04-27T12:00:00.000Z";

function makeDeps(overrides: Partial<RunSynthesisDeps> = {}): RunSynthesisDeps {
  const account = privateKeyToAccount(generatePrivateKey());
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
      agentAddress: account.address,
      imageDigest: "sha256:img",
      commitSha: "abc",
      environment: "local",
    },
    sign: (h) => account.signMessage({ message: h }),
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

  test("happy path: 3 models all agree → 1 consensus claim, signature recovers", async () => {
    const deps = makeDeps();
    const r = await runSynthesis(deps, { topic: "t", sources: [{ text: "src" }] });
    expect(r.status).toBe("ok");
    const m = r.manifest!;
    expect(m.merge.thresholdMet).toBe(true);
    expect(m.merge.successfulModels).toBe(3);
    expect(m.merge.totalModels).toBe(3);
    expect(m.merge.claims).toHaveLength(1);
    expect(m.merge.claims[0].supportingModels).toHaveLength(3);
    expect(m.merge.minorityClaims).toEqual([]);
    expect(m.brief).toContain("Consensus");
    const recovered = await recoverManifestSigner(m.manifestSha256, r.signature!);
    expect(recovered.toLowerCase()).toBe(deps.deployment.agentAddress.toLowerCase());
  });

  test("mixed: 2 agree on A, 1 unique B → 1 consensus + 1 minority", async () => {
    const oddModel = "google/gemini-2.5-pro";
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

  test("2 of 3 models error → thresholdMet=false, status=threshold_not_met", async () => {
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
    expect(m.merge.successfulModels).toBe(1);
    expect(m.merge.totalModels).toBe(3);
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

  test("oversized GPT-4o prompts use a compacted prompt hash only for that model", async () => {
    const callPrompts = new Map<string, string>();
    const bigText = "alpha ".repeat(10_000);
    const deps = makeDeps({
      callModel: async ({ provider, model, prompt }) => {
        callPrompts.set(`${provider}/${model}`, prompt);
        return {
          rawOutput: JSON.stringify({ claims: [{ statement: "x", supportingSourceIndices: [0] }], summary: "s" }),
          latencyMs: 5,
        };
      },
    });

    const r = await runSynthesis(deps, { topic: "t", sources: [{ text: bigText }] });
    const basePrompt = renderPrompt("t", [{ text: bigText }]);
    const gptPrompt = renderPromptForModel({ provider: "openai", model: "gpt-4o", topic: "t", inputs: [{ text: bigText }] });
    const gptModel = r.manifest!.models.find((m) => m.provider === "openai" && m.model === "gpt-4o");
    const sonnetModel = r.manifest!.models.find((m) => m.provider === "anthropic" && m.model === "claude-sonnet-4.6");

    expect(gptModel?.promptHash).toBe(gptPrompt.hash);
    expect(gptModel?.promptHash).not.toBe(basePrompt.hash);
    expect(sonnetModel?.promptHash).toBe(basePrompt.hash);
    expect(callPrompts.get("openai/gpt-4o")).toBe(gptPrompt.text);
    expect(callPrompts.get("anthropic/claude-sonnet-4.6")).toBe(basePrompt.text);
  });

  test("raw outputs returned for each successful model", async () => {
    const deps = makeDeps();
    const r = await runSynthesis(deps, { topic: "t", sources: [{ text: "src" }] });
    expect(r.raw).toHaveLength(3);
    expect(r.raw[0].rawOutput).toContain("claims");
  });

  test("manifestSha256 is deterministic across runs with identical deps", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const baseDeps = (): RunSynthesisDeps => ({
      ...makeDeps(),
      sign: (h) => account.signMessage({ message: h }),
      deployment: {
        appId: "0xapp",
        agentAddress: account.address,
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

describe("runArticleResearch", () => {
  test("fetches one article URL and runs main, pro, and contra agents in order", async () => {
    const callPrompts: string[] = [];
    const deps = makeDeps({
      fetchUrl: async (url) => ({
        kind: "url",
        url,
        contentSha256: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        text: "Acme shares rose after earnings beat expectations, but executives sold stock before guidance was cut.",
        fetchedAt: FIXED_TS,
        byteLength: 94,
        error: null,
      }),
      callModel: async ({ prompt }) => {
        callPrompts.push(prompt);
        if (callPrompts.length === 1) {
          return {
            rawOutput: JSON.stringify({
              proPrompt: "Research evidence that supports the article's market optimism.",
              contraPrompt: "Research evidence that challenges the article's market optimism.",
            }),
            latencyMs: 5,
          };
        }
        if (callPrompts.length === 2) return { rawOutput: "Pro: earnings beat expectations.", latencyMs: 5 };
        return { rawOutput: "Contra: executive stock sales weaken the article's framing.", latencyMs: 5 };
      },
    });

    const result = await runArticleResearch(deps, { articleUrl: "https://news.example/acme" });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected_ok_result");
    expect(result.article.url).toBe("https://news.example/acme");
    expect(result.proPrompt).toContain("supports");
    expect(result.contraPrompt).toContain("challenges");
    expect(result.proAnalysis).toContain("earnings beat");
    expect(result.contraAnalysis).toContain("stock sales");
    expect(result.agentRuns.map((run) => run.role)).toEqual(["main", "pro", "contra"]);
    expect(callPrompts).toHaveLength(3);
    expect(callPrompts[0]).toContain("Create two research prompts");
    expect(callPrompts[1]).toContain("Research evidence that supports");
    expect(callPrompts[2]).toContain("Research evidence that challenges");
  });

  test("rejects non-url article input before model calls", async () => {
    let calls = 0;
    const result = await runArticleResearch(
      makeDeps({
        callModel: async () => {
          calls++;
          return { rawOutput: "should not run", latencyMs: 1 };
        },
      }),
      { articleUrl: "not a url" }
    );

    expect(result.status).toBe("validation_error");
    if (result.status !== "validation_error") throw new Error("expected_validation_error");
    expect(result.error).toBe("article_url_invalid");
    expect(calls).toBe(0);
  });
});
