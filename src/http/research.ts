import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { isUnknownRecord } from "../lib/guards";
import { sha256Hex } from "../lib/hash";
import { log } from "../lib/log";
import { readUrlHost } from "../lib/url";
import { runArticleResearch, type RunSynthesisDeps } from "../pipeline";
import type { NewsResearchRequest, NewsResearchResponse } from "../types";
import { shouldIncludeRaw } from "./query";

type ResearchErrorBody = {
  error: string;
  message: string;
  requestId: string;
  retryable: boolean;
  article?: NewsResearchResponse["article"];
};

export function makeResearchHandler(deps: RunSynthesisDeps) {
  return async (req: Request<Record<string, never>, NewsResearchResponse | ResearchErrorBody, unknown>, res: Response): Promise<void> => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const body = req.body;
    if (!isUnknownRecord(body)) {
      log("warn", "research_request_failed", { requestId, route: "/research", status: 400, error: "body_required", totalLatencyMs: Date.now() - startedAt });
      sendResearchError(res, 400, "body_required", requestId);
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
        sendResearchError(res, 400, result.error, requestId);
        return;
      }
      if (result.status === "fetch_error") {
        const status = statusForResearchError(result.error);
        log("warn", "research_request_failed", {
          requestId,
          route: "/research",
          status,
          error: result.error,
          articleHost: readUrlHost(result.article.url),
          articleUrlHash: sha256Hex(result.article.url),
          byteLength: result.article.byteLength,
          contentSha256: result.article.contentSha256,
          totalLatencyMs: Date.now() - startedAt,
        });
        sendResearchError(res, status, result.error, requestId, result.article);
        return;
      }

      const includeRaw = shouldIncludeRaw(req);
      const { status: _status, raw, ...response } = result;
      const responseBody: NewsResearchResponse = {
        ...response,
        raw: includeRaw ? raw : null,
      };
      log("info", "research_request_completed", {
        requestId,
        route: "/research",
        status: 200,
        articleHost: readUrlHost(responseBody.article.url),
        articleUrlHash: sha256Hex(responseBody.article.url),
        agentRunCount: responseBody.agentRuns.length,
        totalLatencyMs: Date.now() - startedAt,
      });
      res.status(200).json(responseBody);
    } catch (error) {
      log("error", "research_request_failed", {
        requestId,
        route: "/research",
        status: 502,
        error: error instanceof Error ? error.message : String(error),
        totalLatencyMs: Date.now() - startedAt,
      });
      sendResearchError(res, 502, "research_agent_failed", requestId);
    }
  };
}

function sendResearchError(
  res: Response,
  status: number,
  code: string,
  requestId: string,
  article?: NewsResearchResponse["article"],
): void {
  const body: ResearchErrorBody = {
    error: code,
    message: messageForResearchError(code),
    requestId,
    retryable: isRetryableResearchError(code),
    ...(article ? { article } : {}),
  };
  res.status(status).json(body);
}

function statusForResearchError(code: string): number {
  if (code === "timeout") return 504;
  if (code === "http_401" || code === "http_403") return 502;
  if (code === "http_404" || code === "http_410") return 502;
  if (code.startsWith("http_5")) return 502;
  return 502;
}

function isRetryableResearchError(code: string): boolean {
  return code === "timeout" || code === "network_error" || code === "research_agent_failed" || code.startsWith("http_5");
}

function messageForResearchError(code: string): string {
  switch (code) {
    case "body_required":
      return "Send a JSON body with an articleUrl field.";
    case "article_url_required":
      return "Enter a news article URL before starting research.";
    case "article_url_invalid":
      return "Enter a valid HTTP or HTTPS news article URL.";
    case "timeout":
      return "The article or agent request timed out. Please retry in a moment.";
    case "network_error":
      return "The article could not be reached from the research service.";
    case "byte_cap_exceeded":
      return "The article response is too large for the bounded fetcher.";
    case "research_agent_failed":
      return "A research agent failed before both perspectives were completed. Retry the request or inspect server logs with the request ID.";
    default:
      if (code.startsWith("http_")) return `The article request failed upstream (${code}).`;
      return `The research request failed (${code}).`;
  }
}
