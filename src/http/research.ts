import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { isUnknownRecord } from "../lib/guards";
import { sha256Hex } from "../lib/hash";
import { log } from "../lib/log";
import { runArticleResearch, type RunSynthesisDeps } from "../pipeline";
import type { NewsResearchRequest } from "../types";

export function makeResearchHandler(deps: RunSynthesisDeps) {
  return async (req: Request<Record<string, never>, unknown, unknown>, res: Response): Promise<void> => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const body = req.body;
    if (!isUnknownRecord(body)) {
      log("warn", "research_request_failed", { requestId, route: "/research", status: 400, error: "body_required", totalLatencyMs: Date.now() - startedAt });
      res.status(400).json({ error: "body_required" });
      return;
    }

    const request: NewsResearchRequest = {
      articleUrl: typeof body.articleUrl === "string" ? body.articleUrl : "",
      requestId,
    };
    const articleUrl = request.articleUrl.trim();
    log("info", "research_request_started", {
      requestId,
      route: "/research",
      articleHost: readUrlHost(articleUrl),
      articleUrlHash: articleUrl.length > 0 ? sha256Hex(articleUrl) : null,
    });

    try {
      const result = await runArticleResearch(deps, request);
      if (result.status === "validation_error") {
        log("warn", "research_request_failed", { requestId, route: "/research", status: 400, error: result.error, totalLatencyMs: Date.now() - startedAt });
        res.status(400).json({ error: result.error });
        return;
      }
      if (result.status === "fetch_error") {
        log("warn", "research_request_failed", {
          requestId,
          route: "/research",
          status: 502,
          error: result.error,
          articleHost: readUrlHost(result.article.url),
          articleUrlHash: sha256Hex(result.article.url),
          byteLength: result.article.byteLength,
          contentSha256: result.article.contentSha256,
          totalLatencyMs: Date.now() - startedAt,
        });
        res.status(502).json({ error: result.error, article: result.article });
        return;
      }

      const { status: _status, ...response } = result;
      log("info", "research_request_completed", {
        requestId,
        route: "/research",
        status: 200,
        articleHost: readUrlHost(response.article.url),
        articleUrlHash: sha256Hex(response.article.url),
        agentRunCount: response.agentRuns.length,
        totalLatencyMs: Date.now() - startedAt,
      });
      res.status(200).json(response);
    } catch (error) {
      log("error", "research_request_failed", {
        requestId,
        route: "/research",
        status: 502,
        error: error instanceof Error ? error.message : String(error),
        totalLatencyMs: Date.now() - startedAt,
      });
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };
}

function readUrlHost(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
