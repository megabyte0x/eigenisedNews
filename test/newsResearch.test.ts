import { describe, expect, test } from "vitest";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../src/index";
import { ArticleResearchQueue } from "../src/http/researchQueue";
import type { RunSynthesisDeps } from "../src/pipeline";

const FIXED_TS = "2026-04-27T12:00:00.000Z";

function makeApp(overrides: Partial<RunSynthesisDeps> = {}) {
  return buildApp(makeDeps(overrides));
}

function makeDeps(overrides: Partial<RunSynthesisDeps> = {}): RunSynthesisDeps {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
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
      if (prompt.includes("Support the article")) return { rawOutput: "For: earnings evidence supports the article.\nVerdict: supportive.", latencyMs: 5 };
      if (prompt.includes("Challenge the article")) return { rawOutput: "Against: governance timing challenges the article.\nVerdict: cautionary.", latencyMs: 5 };
      return { rawOutput: "Similarities: both takes focus on earnings and governance.\n\nDivergences: pro leans on earnings while contra emphasizes timing.\n\nBottom line: the article is plausible but caveated.", latencyMs: 5 };
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
    expect(res.body.mainSummary).toContain("Divergences");
    expect(res.body.agentRuns.map((run: { role: string }) => run.role)).toEqual(["main", "pro", "contra", "main_summary"]);
    expect(res.body.promptBindings.map((binding: { role: string }) => binding.role)).toEqual(["main", "pro", "contra", "main_summary"]);
    expect(res.body.promptBindings[0].systemPrompt).toContain("main news research agent");
    expect(res.body.promptBindings[1].systemPrompt).toContain("pro news research agent");
    expect(res.body.promptBindings[2].systemPrompt).toContain("contra news research agent");
    expect(res.body.promptBindings[3].systemPrompt).toContain("final reader-facing summary");
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
    expect(res.body.manifest.outputs.mainSummarySha256).toBe(res.body.agentRuns[3].rawOutputSha256);
    expect(res.body.manifest.outputs.summaryAlgorithm).toBe("mainAgentSummary/v1");
    expect(res.body.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(res.body.raw).toBeNull();
  });

  test("?include=raw returns full research audit payload", async () => {
    const res = await request(makeApp())
      .post("/research")
      .query({ include: "raw" })
      .send({ articleUrl: "https://news.example/story" });

    expect(res.status).toBe(200);
    expect(res.body.raw.agentOutputs.map((run: { role: string }) => run.role)).toEqual(["main", "pro", "contra", "main_summary"]);
    expect(res.body.raw.agentOutputs[0].prompt).toContain("Create two research prompts");
    expect(res.body.raw.agentOutputs[0].rawOutput).toContain("proPrompt");
    expect(res.body.raw.agentOutputs[3].prompt).toContain("Pro final verdict");
    expect(res.body.raw.mainSummary).toBe(res.body.mainSummary);
  });

  test("queues multiple article research jobs and exposes completed results", async () => {
    const app = makeApp();
    const enqueue = await request(app)
      .post("/research/jobs")
      .query({ include: "raw" })
      .send({ articleUrls: ["https://news.example/one", "https://news.example/two"] });

    expect(enqueue.status).toBe(202);
    expect(enqueue.body.jobs).toHaveLength(2);
    expect(enqueue.body.queue.active).toBe(2);
    expect(enqueue.body.jobs.map((job: { articleUrl: string }) => job.articleUrl)).toEqual([
      "https://news.example/one",
      "https://news.example/two",
    ]);

    const first = await waitForQueuedJob(app, enqueue.body.jobs[0].id);
    const second = await waitForQueuedJob(app, enqueue.body.jobs[1].id);

    expect(first.status).toBe("succeeded");
    expect(first.result.article.url).toBe("https://news.example/one");
    expect(first.result.raw.agentOutputs).toHaveLength(4);
    expect(second.status).toBe("succeeded");
    expect(second.result.article.url).toBe("https://news.example/two");

    const list = await request(app).get("/research/jobs");
    expect(list.status).toBe(200);
    expect(list.body.queue.succeeded).toBe(2);
    expect(list.body.jobs.map((job: { status: string }) => job.status)).toEqual(["succeeded", "succeeded"]);
  });

  test("runs queued article jobs sequentially", async () => {
    let releaseFirstFetch: (() => void) | null = null;
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const app = makeApp({
      fetchUrl: async (url) => {
        activeFetches++;
        maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
        if (url.endsWith("/one")) {
          await new Promise<void>((resolve) => {
            releaseFirstFetch = resolve;
          });
        }
        activeFetches--;
        return {
          kind: "url",
          url,
          contentSha256: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
          text: "A queued news article about earnings and governance.",
          fetchedAt: FIXED_TS,
          byteLength: 55,
          error: null,
        };
      },
    });

    const enqueue = await request(app)
      .post("/research/jobs")
      .send({ articleUrls: ["https://news.example/one", "https://news.example/two"] });

    expect(enqueue.status).toBe(202);
    const running = await waitForQueuedJobStatus(app, enqueue.body.jobs[0].id, "running");
    const queued = await request(app).get(`/research/jobs/${enqueue.body.jobs[1].id}`);

    expect(running.status).toBe("running");
    expect(queued.body.status).toBe("queued");
    expect(queued.body.position).toBe(1);
    expect(maxActiveFetches).toBe(1);

    const release = releaseFirstFetch as (() => void) | null;
    if (!release) throw new Error("first queued fetch did not start");
    release();
    const first = await waitForQueuedJob(app, enqueue.body.jobs[0].id);
    const second = await waitForQueuedJob(app, enqueue.body.jobs[1].id);
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    expect(maxActiveFetches).toBe(1);
  });

  test("persists queued article results when a store path is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eigenised-news-queue-"));
    const storePath = join(dir, "research-queue.json");
    try {
      const deps = makeDeps();
      const queue = new ArticleResearchQueue(deps, { storePath });
      const [job] = queue.enqueueMany(["https://news.example/persisted"], true);

      const completed = await waitForQueueJob(queue, job.id);
      expect(completed.status).toBe("succeeded");
      expect(completed.result?.raw?.agentOutputs).toHaveLength(4);

      const persisted = JSON.parse(readFileSync(storePath, "utf8")) as { jobs: Array<{ id: string; status: string }> };
      expect(persisted.jobs[0]).toMatchObject({ id: job.id, status: "succeeded" });

      const restored = new ArticleResearchQueue(deps, { storePath });
      expect(restored.find(job.id)?.status).toBe("succeeded");
      expect(restored.summary().storage).toBe("file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
        if (prompt.includes("Support the article")) return { rawOutput: "For: direct evidence supports it.\nVerdict: direct evidence helps.", latencyMs: 5 };
        if (prompt.includes("Challenge the article")) return { rawOutput: "Against: missing context complicates it.\nVerdict: context is incomplete.", latencyMs: 5 };
        return { rawOutput: "Similarities: both cite the same source.\n\nDivergences: pro trusts direct evidence while contra flags missing context.\n\nBottom line: read with caveats.", latencyMs: 5 };
      },
    })).post("/research").send({ articleUrl: "https://news.example/noisy" });

    expect(res.status).toBe(200);
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toContain("Operation Sindoor & Pahalgam 📰 &#99999999;");
    expect(prompts[0]).toContain("truncated for research context");
    expect(prompts[0]).not.toContain("<script>");
    expect(prompts[0]).not.toContain("<article>");
    expect(prompts.every((prompt) => prompt.length < 14_000)).toBe(true);
  });
});

async function waitForQueuedJob(app: ReturnType<typeof makeApp>, jobId: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await request(app).get(`/research/jobs/${jobId}`);
    expect(res.status).toBe(200);
    if (res.body.status === "succeeded" || res.body.status === "failed") return res.body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`queued job ${jobId} did not finish`);
}

async function waitForQueuedJobStatus(app: ReturnType<typeof makeApp>, jobId: string, status: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await request(app).get(`/research/jobs/${jobId}`);
    expect(res.status).toBe(200);
    if (res.body.status === status) return res.body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`queued job ${jobId} did not reach ${status}`);
}

async function waitForQueueJob(queue: ArticleResearchQueue, jobId: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const job = queue.find(jobId);
    if (job?.status === "succeeded" || job?.status === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`queued job ${jobId} did not finish`);
}
