import { describe, expect, test } from "vitest";
import request from "supertest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../src/index";
import type { RunSynthesisDeps } from "../src/pipeline";

const FIXED_TS = "2026-04-27T12:00:00.000Z";

function makeApp(overrides: Partial<RunSynthesisDeps> = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const deps: RunSynthesisDeps = {
    fetchUrl: async (url) => ({
      kind: "url",
      url,
      contentSha256: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      text: "A news article about earnings, market reaction, and governance concerns.",
      fetchedAt: FIXED_TS,
      byteLength: 70,
      error: null,
    }),
    callModel: async ({ prompt }) => {
      if (prompt.includes("Create two research prompts")) {
        return {
          rawOutput: JSON.stringify({
            proPrompt: "Support the article with market and earnings evidence.",
            contraPrompt: "Challenge the article with governance and timing evidence.",
          }),
          latencyMs: 5,
        };
      }
      if (prompt.includes("Support the article")) return { rawOutput: "For: earnings evidence supports the article.", latencyMs: 5 };
      return { rawOutput: "Against: governance timing challenges the article.", latencyMs: 5 };
    },
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
  return buildApp(deps);
}

describe("POST /research", () => {
  test("returns the URL-first pro/con research result", async () => {
    const res = await request(makeApp()).post("/research").send({ articleUrl: "https://news.example/story" });

    expect(res.status).toBe(200);
    expect(res.body.article.url).toBe("https://news.example/story");
    expect(res.body.proPrompt).toContain("Support the article");
    expect(res.body.contraPrompt).toContain("Challenge the article");
    expect(res.body.proAnalysis).toContain("earnings evidence");
    expect(res.body.contraAnalysis).toContain("governance timing");
    expect(res.body.agentRuns.map((run: { role: string }) => run.role)).toEqual(["main", "pro", "contra"]);
    expect(res.body.promptBindings.map((binding: { role: string }) => binding.role)).toEqual(["main", "pro", "contra"]);
    expect(res.body.promptBindings[0].systemPrompt).toContain("main news research agent");
    expect(res.body.promptBindings[1].systemPrompt).toContain("pro news research agent");
    expect(res.body.promptBindings[2].systemPrompt).toContain("contra news research agent");
    expect(res.body.promptBindings[1].researchPrompt).toContain("Support the article");
    expect(res.body.promptBindings[1].promptHash).toBe(res.body.agentRuns[1].promptHash);
    expect(res.body.promptBindings[1].articleContentSha256).toBe(res.body.article.contentSha256);
    expect(res.body.verifiableBuild).toMatchObject({
      appId: "0xapp",
      imageDigest: "sha256:img",
      commitSha: "abc",
      promptSourcePath: "src/pipeline.ts",
    });
    expect(res.body.verifiableBuild.promptSourceUrl).toContain("/blob/abc/src/pipeline.ts");
    expect(res.body.manifest.kind).toBe("research");
    expect(res.body.manifest.article).toEqual(res.body.article);
    expect(res.body.manifest.outputs.proAnalysisSha256).toBe(res.body.agentRuns[1].rawOutputSha256);
    expect(res.body.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(res.body.raw).toBeNull();
  });

  test("?include=raw returns full research audit payload", async () => {
    const res = await request(makeApp())
      .post("/research")
      .query({ include: "raw" })
      .send({ articleUrl: "https://news.example/story" });

    expect(res.status).toBe(200);
    expect(res.body.raw.agentOutputs.map((run: { role: string }) => run.role)).toEqual(["main", "pro", "contra"]);
    expect(res.body.raw.agentOutputs[0].prompt).toContain("Create two research prompts");
    expect(res.body.raw.agentOutputs[0].rawOutput).toContain("proPrompt");
    expect(res.body.raw.mainSummary).toBe(res.body.mainSummary);
  });

  test("returns a validation error for invalid article URLs", async () => {
    const res = await request(makeApp()).post("/research").send({ articleUrl: "not a url" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("article_url_invalid");
    expect(res.body.message).toMatch(/valid HTTP or HTTPS/i);
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  test("returns clean agent errors without leaking upstream details", async () => {
    const res = await request(makeApp({
      callModel: async () => {
        throw new Error("secret upstream credential detail");
      },
    })).post("/research").send({ articleUrl: "https://news.example/story" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("research_agent_failed");
    expect(res.body.message).toMatch(/research agent failed/i);
    expect(res.body.requestId).toEqual(expect.any(String));
    expect(res.body.retryable).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("secret upstream credential detail");
  });

  test("returns structured fetch errors with article metadata", async () => {
    const res = await request(makeApp({
      fetchUrl: async (url) => ({
        kind: "url",
        url,
        contentSha256: null,
        text: "",
        fetchedAt: FIXED_TS,
        byteLength: 0,
        error: "http_500",
      }),
    })).post("/research").send({ articleUrl: "https://news.example/down" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("http_500");
    expect(res.body.message).toContain("article request failed upstream");
    expect(res.body.retryable).toBe(true);
    expect(res.body.article.url).toBe("https://news.example/down");
  });

  test("cleans and bounds HTML article context before model calls", async () => {
    const prompts: string[] = [];
    const noisyHtml = `<!doctype html><html><head><title>Chrome</title><script>window.noise = true</script></head><body><article><h1>Operation Sindoor &amp; Pahalgam &#x1f4f0; &#99999999;</h1><p>${"Evidence from the article. ".repeat(900)}</p></article></body></html>`;
    const res = await request(makeApp({
      fetchUrl: async (url) => ({
        kind: "url",
        url,
        contentSha256: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        text: noisyHtml,
        fetchedAt: FIXED_TS,
        byteLength: Buffer.byteLength(noisyHtml, "utf8"),
        error: null,
      }),
      callModel: async ({ prompt }) => {
        prompts.push(prompt);
        if (prompt.includes("Create two research prompts")) {
          return {
            rawOutput: JSON.stringify({
              proPrompt: "Support the article with direct evidence.",
              contraPrompt: "Challenge the article with missing context.",
            }),
            latencyMs: 5,
          };
        }
        if (prompt.includes("Support the article")) return { rawOutput: "For: direct evidence supports it.", latencyMs: 5 };
        return { rawOutput: "Against: missing context complicates it.", latencyMs: 5 };
      },
    })).post("/research").send({ articleUrl: "https://news.example/noisy" });

    expect(res.status).toBe(200);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("Operation Sindoor & Pahalgam 📰 &#99999999;");
    expect(prompts[0]).toContain("truncated for research context");
    expect(prompts[0]).not.toContain("<script>");
    expect(prompts[0]).not.toContain("<article>");
    expect(prompts.every((prompt) => prompt.length < 14_000)).toBe(true);
  });
});
