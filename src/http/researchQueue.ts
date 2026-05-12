import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isNewsResearchResponse } from "../lib/manifestGuards";
import { isUnknownRecord } from "../lib/guards";
import { sha256Hex } from "../lib/hash";
import { log } from "../lib/log";
import { isHttpUrl, readUrlHost } from "../lib/url";
import { runArticleResearch, type RunSynthesisDeps } from "../pipeline";
import { clientResearchResponse, type ResearchReportStore } from "../storage/researchStore";
import type {
  NewsResearchQueueEnqueueResponse,
  NewsResearchQueueError,
  NewsResearchQueueJob,
  NewsResearchQueueJobStatus,
  NewsResearchQueueListResponse,
  NewsResearchQueueSummary,
  NewsResearchResponse,
} from "../types";
import { shouldIncludeRaw } from "./query";
import { buildResearchErrorBody } from "./research";

export const RESEARCH_QUEUE_PATH = "/research/jobs";

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_MAX_JOBS = 100;
const DEFAULT_MAX_BATCH_SIZE = 20;

type InternalResearchJob = Omit<NewsResearchQueueJob, "position"> & {
  includeRaw: boolean;
};

type ResearchQueueOptions = {
  concurrency: number;
  maxJobs: number;
  maxBatchSize: number;
  storePath: string | null;
  store?: ResearchReportStore;
};

type QueueStoreFile = {
  version: 1;
  jobs: InternalResearchJob[];
};

export class ArticleResearchQueue {
  readonly concurrency: number;
  readonly maxJobs: number;
  readonly maxBatchSize: number;
  readonly storePath: string | null;

  private readonly deps: RunSynthesisDeps;
  private readonly store?: ResearchReportStore;
  private readonly jobs: InternalResearchJob[];
  private activeCount = 0;
  private pumpScheduled = false;

  constructor(deps: RunSynthesisDeps, options: Partial<ResearchQueueOptions> = {}) {
    this.deps = deps;
    this.concurrency = positiveInteger(options.concurrency, DEFAULT_CONCURRENCY);
    this.maxJobs = positiveInteger(options.maxJobs, DEFAULT_MAX_JOBS);
    this.maxBatchSize = positiveInteger(options.maxBatchSize, DEFAULT_MAX_BATCH_SIZE);
    this.storePath = options.storePath?.trim() || null;
    this.store = options.store;
    this.jobs = this.loadPersistedJobs();
    if (this.jobs.some((job) => job.status === "queued")) this.schedulePump();
  }

  enqueueMany(articleUrls: string[], includeRaw: boolean): NewsResearchQueueJob[] {
    const now = this.deps.now();
    const jobs = articleUrls.map((articleUrl): InternalResearchJob => ({
      id: randomUUID(),
      requestId: randomUUID(),
      articleUrl,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      includeRaw,
    }));
    this.jobs.push(...jobs);
    this.trimJobs();
    this.persist();
    this.schedulePump();
    return jobs.map((job) => this.view(job));
  }

  list(): NewsResearchQueueJob[] {
    return this.jobs.map((job) => this.view(job));
  }

  find(jobId: string): NewsResearchQueueJob | null {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    return job ? this.view(job) : null;
  }

  summary(): NewsResearchQueueSummary {
    const counts = this.jobs.reduce<Record<NewsResearchQueueJobStatus, number>>((acc, job) => {
      acc[job.status]++;
      return acc;
    }, { queued: 0, running: 0, succeeded: 0, failed: 0 });
    return {
      ...counts,
      active: counts.queued + counts.running,
      total: this.jobs.length,
      concurrency: this.concurrency,
      maxJobs: this.maxJobs,
      storage: this.storePath ? "file" : "memory",
    };
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setTimeout(() => {
      this.pumpScheduled = false;
      this.pump();
    }, 0);
  }

  private pump(): void {
    while (this.activeCount < this.concurrency) {
      const job = this.jobs.find((candidate) => candidate.status === "queued");
      if (!job) return;
      this.start(job);
    }
  }

  private start(job: InternalResearchJob): void {
    const now = this.deps.now();
    job.status = "running";
    job.startedAt = now;
    job.updatedAt = now;
    job.error = null;
    this.activeCount++;
    this.persist();
    log("info", "research_queue_job_started", {
      requestId: job.requestId,
      jobId: job.id,
      route: RESEARCH_QUEUE_PATH,
      articleHost: readUrlHost(job.articleUrl),
      articleUrlHash: sha256Hex(job.articleUrl),
    });
    void this.run(job).finally(() => {
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.trimJobs();
      this.persist();
      this.schedulePump();
    });
  }

  private async run(job: InternalResearchJob): Promise<void> {
    try {
      const result = await runArticleResearch(this.deps, { articleUrl: job.articleUrl, requestId: job.requestId });
      if (result.status === "validation_error") {
        this.fail(job, buildResearchErrorBody(result.error, job.requestId));
        return;
      }
      if (result.status === "fetch_error") {
        this.fail(job, buildResearchErrorBody(result.error, job.requestId, result.article));
        return;
      }

      const { status: _status, raw, ...response } = result;
      const fullResponse: NewsResearchResponse = {
        ...response,
        raw,
      };
      await this.saveStoredReport(fullResponse, job);
      const responseBody = clientResearchResponse(fullResponse, job.includeRaw);
      const now = this.deps.now();
      job.status = "succeeded";
      job.result = responseBody;
      job.error = null;
      job.finishedAt = now;
      job.updatedAt = now;
      log("info", "research_queue_job_completed", {
        requestId: job.requestId,
        jobId: job.id,
        route: RESEARCH_QUEUE_PATH,
        articleHost: readUrlHost(responseBody.article.url),
        articleUrlHash: sha256Hex(responseBody.article.url),
        agentRunCount: responseBody.agentRuns.length,
      });
    } catch (error) {
      log("error", "research_queue_job_failed", {
        requestId: job.requestId,
        jobId: job.id,
        route: RESEARCH_QUEUE_PATH,
        error: error instanceof Error ? error.message : String(error),
      });
      this.fail(job, buildResearchErrorBody("research_agent_failed", job.requestId));
    }
  }

  private fail(job: InternalResearchJob, error: NewsResearchQueueError): void {
    const now = this.deps.now();
    job.status = "failed";
    job.result = null;
    job.error = error;
    job.finishedAt = now;
    job.updatedAt = now;
  }

  private view(job: InternalResearchJob): NewsResearchQueueJob {
    return {
      id: job.id,
      requestId: job.requestId,
      articleUrl: job.articleUrl,
      status: job.status,
      position: this.positionFor(job),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      result: job.result,
      error: job.error,
    };
  }

  private positionFor(job: InternalResearchJob): number | null {
    if (job.status !== "queued") return null;
    return this.jobs.filter((candidate) => candidate.status === "queued").findIndex((candidate) => candidate.id === job.id) + 1;
  }

  private async saveStoredReport(response: NewsResearchResponse, job: InternalResearchJob): Promise<void> {
    if (!this.store) return;
    try {
      const stored = await this.store.save(response);
      log("info", "research_queue_report_saved", {
        requestId: job.requestId,
        jobId: job.id,
        route: RESEARCH_QUEUE_PATH,
        reportId: stored.id,
        storageSource: this.store.info.source,
      });
    } catch (error) {
      log("warn", "research_queue_report_save_failed", {
        requestId: job.requestId,
        jobId: job.id,
        route: RESEARCH_QUEUE_PATH,
        storageSource: this.store.info.source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private trimJobs(): void {
    if (this.jobs.length <= this.maxJobs) return;
    const terminalJobs = this.jobs
      .map((job, index) => ({ job, index }))
      .filter(({ job }) => job.status === "succeeded" || job.status === "failed")
      .sort((a, b) => a.job.updatedAt.localeCompare(b.job.updatedAt));
    const removableCount = Math.min(this.jobs.length - this.maxJobs, terminalJobs.length);
    const remove = new Set(terminalJobs.slice(0, removableCount).map(({ index }) => index));
    if (remove.size === 0) return;
    const kept = this.jobs.filter((_job, index) => !remove.has(index));
    this.jobs.length = 0;
    this.jobs.push(...kept);
  }

  private loadPersistedJobs(): InternalResearchJob[] {
    if (!this.storePath || !existsSync(this.storePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.storePath, "utf8")) as unknown;
      if (!isQueueStoreFile(parsed)) return [];
      const now = this.deps.now();
      return parsed.jobs.map((job) => {
        if (job.status !== "running") return job;
        return {
          ...job,
          status: "queued",
          startedAt: null,
          updatedAt: now,
          error: null,
        };
      });
    } catch (error) {
      log("warn", "research_queue_restore_failed", {
        storePath: this.storePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private persist(): void {
    if (!this.storePath) return;
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      const tmpPath = `${this.storePath}.${process.pid}.tmp`;
      const payload: QueueStoreFile = { version: 1, jobs: this.jobs };
      writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      renameSync(tmpPath, this.storePath);
    } catch (error) {
      log("error", "research_queue_persist_failed", {
        storePath: this.storePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

type ResearchQueueMountOptions = {
  store?: ResearchReportStore;
  env?: NodeJS.ProcessEnv;
};

export function mountResearchQueueApi(app: Express, deps: RunSynthesisDeps, options: ResearchQueueMountOptions = {}): void {
  const queue = new ArticleResearchQueue(deps, {
    ...readResearchQueueOptions(options.env ?? process.env),
    store: options.store,
  });

  app.post(RESEARCH_QUEUE_PATH, (req: Request<Record<string, never>, NewsResearchQueueEnqueueResponse | NewsResearchQueueError, unknown>, res: Response) => {
    const parsed = parseQueueRequest(req.body, queue.maxBatchSize);
    if (!parsed.ok) {
      res.status(400).json(buildResearchErrorBody(parsed.error, randomUUID()));
      return;
    }

    const jobs = queue.enqueueMany(parsed.articleUrls, shouldIncludeRaw(req));
    log("info", "research_queue_jobs_enqueued", {
      route: RESEARCH_QUEUE_PATH,
      jobCount: jobs.length,
      articleHosts: jobs.map((job) => readUrlHost(job.articleUrl)),
      articleUrlHashes: jobs.map((job) => sha256Hex(job.articleUrl)),
    });
    res.status(202).json({ jobs, queue: queue.summary() });
  });

  app.get(RESEARCH_QUEUE_PATH, (_req: Request, res: Response<NewsResearchQueueListResponse>) => {
    res.status(200).json({ jobs: queue.list(), queue: queue.summary() });
  });

  app.get(`${RESEARCH_QUEUE_PATH}/:jobId`, (req: Request<{ jobId: string }>, res: Response<NewsResearchQueueJob | NewsResearchQueueError>) => {
    const job = queue.find(req.params.jobId);
    if (!job) {
      res.status(404).json(buildResearchErrorBody("queue_job_not_found", req.params.jobId));
      return;
    }
    res.status(200).json(job);
  });
}

function parseQueueRequest(body: unknown, maxBatchSize: number): { ok: true; articleUrls: string[] } | { ok: false; error: string } {
  if (!isUnknownRecord(body)) return { ok: false, error: "body_required" };
  const articleUrls = readArticleUrls(body);
  if (articleUrls.length === 0) return { ok: false, error: "article_url_required" };
  if (articleUrls.length > maxBatchSize) return { ok: false, error: "too_many_article_urls" };
  if (articleUrls.some((url) => !isHttpUrl(url))) return { ok: false, error: "article_url_invalid" };
  return { ok: true, articleUrls };
}

function readArticleUrls(body: Record<string, unknown>): string[] {
  const urls: string[] = [];
  if (typeof body.articleUrl === "string") urls.push(body.articleUrl);
  if (Array.isArray(body.articleUrls)) {
    for (const value of body.articleUrls) {
      if (typeof value === "string") urls.push(value);
    }
  }
  return urls.map((url) => url.trim()).filter((url) => url.length > 0);
}

function readResearchQueueOptions(env: NodeJS.ProcessEnv): ResearchQueueOptions {
  return {
    concurrency: readPositiveIntegerEnv(env.RESEARCH_QUEUE_CONCURRENCY, DEFAULT_CONCURRENCY),
    maxJobs: readPositiveIntegerEnv(env.RESEARCH_QUEUE_MAX_JOBS, DEFAULT_MAX_JOBS),
    maxBatchSize: readPositiveIntegerEnv(env.RESEARCH_QUEUE_MAX_BATCH_SIZE, DEFAULT_MAX_BATCH_SIZE),
    storePath: env.RESEARCH_QUEUE_STORE_PATH?.trim() || null,
  };
}

function readPositiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  return positiveInteger(Number.parseInt(value, 10), fallback);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function isQueueStoreFile(value: unknown): value is QueueStoreFile {
  return (
    isUnknownRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.jobs) &&
    value.jobs.every(isInternalResearchJob)
  );
}

function isInternalResearchJob(value: unknown): value is InternalResearchJob {
  return (
    isUnknownRecord(value) &&
    typeof value.id === "string" &&
    typeof value.requestId === "string" &&
    typeof value.articleUrl === "string" &&
    isQueueStatus(value.status) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (typeof value.startedAt === "string" || value.startedAt === null) &&
    (typeof value.finishedAt === "string" || value.finishedAt === null) &&
    (value.result === null || isNewsResearchResponse(value.result)) &&
    (value.error === null || isResearchQueueError(value.error)) &&
    typeof value.includeRaw === "boolean"
  );
}

function isQueueStatus(value: unknown): value is NewsResearchQueueJobStatus {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed";
}

function isResearchQueueError(value: unknown): value is NewsResearchQueueError {
  return (
    isUnknownRecord(value) &&
    typeof value.error === "string" &&
    typeof value.message === "string" &&
    typeof value.requestId === "string" &&
    typeof value.retryable === "boolean" &&
    (!("article" in value) || value.article === undefined || isResearchArticle(value.article))
  );
}

function isResearchArticle(value: unknown): value is NewsResearchResponse["article"] {
  return (
    isUnknownRecord(value) &&
    typeof value.url === "string" &&
    (typeof value.contentSha256 === "string" || value.contentSha256 === null) &&
    (!("fetchedAt" in value) || value.fetchedAt === undefined || typeof value.fetchedAt === "string") &&
    typeof value.byteLength === "number" &&
    (typeof value.error === "string" || value.error === null)
  );
}
