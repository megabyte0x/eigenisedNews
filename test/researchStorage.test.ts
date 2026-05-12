import { describe, expect, test } from "vitest";
import request from "supertest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../src/index";
import type { RunSynthesisDeps } from "../src/pipeline";

const FIXED_TS = "2026-05-08T10:00:00.000Z";

describe("research persistent storage", () => {
  test("stores successful research reports, lists them, and reuses duplicates without rerunning agents", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "eigenised-news-storage-"));
    const previousStorageDir = process.env.RESEARCH_STORAGE_DIR;
    process.env.RESEARCH_STORAGE_DIR = storageDir;

    let fetchCalls = 0;
    let modelCalls = 0;
    const deps = makeDeps({
      fetchUrl: async (url) => {
        fetchCalls++;
        return {
          kind: "url",
          url,
          contentSha256: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
          text: "A stored news article about earnings, market reaction, and governance concerns.",
          fetchedAt: FIXED_TS,
          byteLength: 78,
          error: null,
        };
      },
      callModel: async ({ prompt }) => {
        modelCalls++;
        if (prompt.includes("Create two research prompts")) {
          return {
            rawOutput: JSON.stringify({
              proPrompt: "Support the article with market and earnings evidence.",
              contraPrompt: "Challenge the article with governance and timing evidence.",
            }),
            latencyMs: 5,
          };
        }
        if (prompt.includes("Support the article")) return { rawOutput: "For: stored earnings evidence supports the article.\nVerdict: supportive.", latencyMs: 5 };
        if (prompt.includes("Challenge the article")) return { rawOutput: "Against: stored governance timing challenges the article.\nVerdict: cautionary.", latencyMs: 5 };
        return { rawOutput: "Similarities: both discuss stored evidence.\n\nDivergences: pro emphasizes earnings while contra emphasizes governance timing.\n\nBottom line: the stored report is balanced.", latencyMs: 5 };
      },
    });

    try {
      const app = buildApp(deps);
      const submittedUrl = "https://News.example/story?b=2&a=1#section";
      const duplicateUrl = "https://news.example/story?a=1&b=2";

      const first = await request(app)
        .post("/research?include=raw")
        .send({ articleUrl: submittedUrl });

      expect(first.status).toBe(200);
      expect(first.body.raw.agentOutputs).toHaveLength(4);
      expect(fetchCalls).toBe(1);
      expect(modelCalls).toBe(4);

      const history = await request(app).get("/research/history");
      expect(history.status).toBe(200);
      expect(history.body.storage).toMatchObject({
        source: "research_storage_dir",
        reportsPath: storageDir,
      });
      expect(history.body.entries).toHaveLength(1);
      expect(history.body.entries[0]).toMatchObject({
        articleUrl: submittedUrl,
        normalizedArticleUrl: duplicateUrl,
        articleHost: "news.example",
        manifestSha256: first.body.manifest.manifestSha256,
      });

      const second = await request(app)
        .post("/research")
        .send({ articleUrl: duplicateUrl });

      expect(second.status).toBe(200);
      expect(second.body.manifest.manifestSha256).toBe(first.body.manifest.manifestSha256);
      expect(second.body.raw).toBeNull();
      expect(fetchCalls).toBe(1);
      expect(modelCalls).toBe(4);

      const reportId = history.body.entries[0].id;
      const detail = await request(app).get(`/research/history/${reportId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.raw).toBeNull();

      const rawDetail = await request(app).get(`/research/history/${reportId}?include=raw`);
      expect(rawDetail.status).toBe(200);
      expect(rawDetail.body.raw.agentOutputs).toHaveLength(4);
    } finally {
      if (previousStorageDir === undefined) delete process.env.RESEARCH_STORAGE_DIR;
      else process.env.RESEARCH_STORAGE_DIR = previousStorageDir;
    }
  });
});

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
      return { rawOutput: "Similarities: both address earnings and governance.\n\nDivergences: pro emphasizes earnings while contra emphasizes timing.\n\nBottom line: the article is plausible but caveated.", latencyMs: 5 };
    },
    now: () => FIXED_TS,
    deployment: {
      appId: "0xapp",
      agentAddress: account.address,
      imageDigest: "sha256:img",
      commitSha: "abc",
      environment: "sepolia",
    },
    sign: (h) => account.signMessage({ message: h }),
    ...overrides,
  };
}
