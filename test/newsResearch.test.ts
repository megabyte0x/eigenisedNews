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
  });

  test("returns a validation error for invalid article URLs", async () => {
    const res = await request(makeApp()).post("/research").send({ articleUrl: "not a url" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("article_url_invalid");
  });

  test("cleans and bounds HTML article context before model calls", async () => {
    const prompts: string[] = [];
    const noisyHtml = `<!doctype html><html><head><title>Chrome</title><script>window.noise = true</script></head><body><article><h1>Operation Sindoor &amp; Pahalgam</h1><p>${"Evidence from the article. ".repeat(900)}</p></article></body></html>`;
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
    expect(prompts[0]).toContain("Operation Sindoor & Pahalgam");
    expect(prompts[0]).toContain("truncated for research context");
    expect(prompts[0]).not.toContain("<script>");
    expect(prompts[0]).not.toContain("<article>");
    expect(prompts.every((prompt) => prompt.length < 14_000)).toBe(true);
  });
});
