import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { isUnknownRecord } from "../lib/guards";
import { sha256Hex } from "../lib/hash";
import { log } from "../lib/log";
import { readUrlHost } from "../lib/url";
import { runArticleResearch, type RunSynthesisDeps } from "../pipeline";
import { clientResearchResponse, type ResearchReportStore } from "../storage/researchStore";
import type { NewsResearchRequest, NewsResearchResponse } from "../types";
import { shouldIncludeRaw } from "./query";

export type ResearchErrorBody = {
  error: string;
  message: string;
  requestId: string;
  retryable: boolean;
  article?: NewsResearchResponse["article"];
};

type ResearchHandlerOptions = {
  store?: ResearchReportStore;
};

export function makeResearchHandler(deps: RunSynthesisDeps, options: ResearchHandlerOptions = {}) {
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
      const includeRaw = shouldIncludeRaw(req);
      if (isHttpUrlForStorageLookup(articleUrl) && options.store) {
        const stored = await findStoredReport(options.store, articleUrl, requestId);
        if (stored) {
          const responseBody = clientResearchResponse(stored.response, includeRaw);
          log("info", "research_request_completed", {
            requestId,
            route: "/research",
            status: 200,
            source: "persistent_storage",
            reportId: stored.id,
            articleHost: readUrlHost(responseBody.article.url),
            articleUrlHash: sha256Hex(responseBody.manifest.request.articleUrl),
            agentRunCount: responseBody.agentRuns.length,
            totalLatencyMs: Date.now() - startedAt,
          });
          res.status(200).json(responseBody);
          return;
        }
      }

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

      const { status: _status, raw, ...response } = result;
      const fullResponse: NewsResearchResponse = {
        ...response,
        raw,
      };
      await saveStoredReport(options.store, fullResponse, requestId);
      const responseBody = clientResearchResponse(fullResponse, includeRaw);
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

async function findStoredReport(store: ResearchReportStore, articleUrl: string, requestId: string) {
  try {
    return await store.findByArticleUrl(articleUrl);
  } catch (error) {
    log("warn", "research_storage_lookup_failed", {
      requestId,
      route: "/research",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function saveStoredReport(store: ResearchReportStore | undefined, response: NewsResearchResponse, requestId: string): Promise<void> {
  if (!store) return;
  try {
    const stored = await store.save(response);
    log("info", "research_report_saved", {
      requestId,
      route: "/research",
      reportId: stored.id,
      storageSource: store.info.source,
      storageDocs: store.info.docsUrl,
    });
  } catch (error) {
    log("warn", "research_report_save_failed", {
      requestId,
      route: "/research",
      storageSource: store.info.source,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isHttpUrlForStorageLookup(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function sendResearchError(
  res: Response,
  status: number,
  code: string,
  requestId: string,
  article?: NewsResearchResponse["article"],
): void {
  res.status(status).json(buildResearchErrorBody(code, requestId, article));
}

export function buildResearchErrorBody(
  code: string,
  requestId: string,
  article?: NewsResearchResponse["article"],
): ResearchErrorBody {
  return {
    error: code,
    message: messageForResearchError(code),
    requestId,
    retryable: isRetryableResearchError(code),
    ...(article ? { article } : {}),
  };
}

export function statusForResearchError(code: string): number {
  if (code === "timeout") return 504;
  if (code === "http_401" || code === "http_403") return 502;
  if (code === "http_404" || code === "http_410") return 502;
  if (code.startsWith("http_5")) return 502;
  return 502;
}

export function isRetryableResearchError(code: string): boolean {
  return code === "timeout" || code === "network_error" || code === "research_agent_failed" || code.startsWith("http_5");
}

export function messageForResearchError(code: string): string {
  switch (code) {
    case "body_required":
      return "Send a JSON body with an articleUrl field.";
    case "article_url_required":
      return "Enter a news article URL before starting research.";
    case "article_url_invalid":
      return "Enter a valid HTTP or HTTPS news article URL.";
    case "too_many_article_urls":
      return "Queue fewer article URLs at once.";
    case "queue_job_not_found":
      return "No queued research job exists for that ID.";
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
