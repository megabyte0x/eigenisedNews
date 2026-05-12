import { useEffect, useState, type ReactNode } from "react";
import type { NewsResearchQueueEnqueueResponse, NewsResearchQueueJob, NewsResearchResponse } from "../types";
import { isUnknownRecord } from "../lib/guards";
import { isNewsResearchResponse } from "../lib/manifestGuards";
import { isHttpUrl } from "../lib/url";
import { resolveFrontendApiUrl } from "./runtimeConfig";
import type { FetchLike, SubmitEventLike } from "./types";

type NewsResearchAppProps = {
  fetchImpl?: FetchLike;
};

type ResearchStatus =
  | { kind: "idle" }
  | { kind: "client_error"; message: string }
  | { kind: "submitting" }
  | { kind: "api_error"; message: string; code: string | null; requestId: string | null; retryable: boolean | null }
  | { kind: "success" };

type ResearchApiError = {
  code: string | null;
  message: string;
  requestId: string | null;
  retryable: boolean | null;
};

type FormattedBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "divider" }
  | { kind: "list"; items: string[] };

const SURFACE = "surface-card";
const inputClassName = "form-input";

export function NewsResearchApp({ fetchImpl = fetch }: NewsResearchAppProps) {
  const [articleUrlsInput, setArticleUrlsInput] = useState("");
  const [status, setStatus] = useState<ResearchStatus>({ kind: "idle" });
  const [jobs, setJobs] = useState<NewsResearchQueueJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const activeJobIds = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => job.id);
  const activeJobIdsKey = activeJobIds.join("|");

  useEffect(() => {
    if (activeJobIdsKey.length === 0) return;

    let cancelled = false;
    async function pollQueueJobs() {
      const ids = activeJobIdsKey.split("|").filter(Boolean);
      const refreshedJobs = await Promise.all(ids.map((id) => fetchQueueJob(fetchImpl, id)));
      if (cancelled) return;
      setJobs((current) => mergeQueueJobs(current, refreshedJobs.filter((job): job is NewsResearchQueueJob => job !== null)));
    }

    void pollQueueJobs();
    const timer = setInterval(() => {
      void pollQueueJobs();
    }, 1500);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeJobIdsKey, fetchImpl]);

  async function onSubmit(event: SubmitEventLike) {
    event.preventDefault();
    const articleUrls = parseArticleUrls(articleUrlsInput);
    if (articleUrls.length === 0) {
      setStatus({ kind: "client_error", message: "Enter at least one news article URL before queueing research." });
      return;
    }
    const invalidUrl = articleUrls.find((url) => !isHttpUrl(url));
    if (invalidUrl) {
      setStatus({ kind: "client_error", message: `Enter valid HTTP or HTTPS news article URLs. Invalid: ${invalidUrl}` });
      return;
    }

    setStatus({ kind: "submitting" });
    try {
      const res = await fetchImpl(resolveFrontendApiUrl("research/jobs", { includeRaw: true }), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ articleUrls }),
      });
      const body = await readResponseJson(res);
      if (!res.ok) {
        setStatus({ kind: "api_error", ...normalizeResearchApiError(body, res.status) });
        return;
      }
      if (!isQueueEnqueueResponse(body)) {
        setStatus({
          kind: "api_error",
          code: "malformed_response",
          message: "The research queue returned an unexpected response shape.",
          requestId: null,
          retryable: false,
        });
        return;
      }
      setJobs((current) => mergeQueueJobs(current, body.jobs));
      setSelectedJobId((current) => current ?? body.jobs[0]?.id ?? null);
      setArticleUrlsInput("");
      setStatus({ kind: "success" });
    } catch (error) {
      setStatus({
        kind: "api_error",
        code: "transport_error",
        message: error instanceof Error ? error.message : String(error),
        requestId: null,
        retryable: true,
      });
    }
  }

  const selectedJob = selectedJobId ? jobs.find((job) => job.id === selectedJobId) ?? null : null;
  const latestSucceededJob = jobs.find((job) => job.status === "succeeded" && job.result) ?? null;
  const displayJob = selectedJob?.result ? selectedJob : latestSucceededJob;
  const response = displayJob?.result ?? null;
  const hasActiveJobs = jobs.some((job) => job.status === "queued" || job.status === "running");

  return (
    <div className="app-shell">
      <div className="app-shell__inner app-shell__inner--spacious">
        <header className={`${SURFACE} surface-card--hero`}>
          <div className="surface-card__body surface-card__body--hero hero-grid">
            <div>
              <p className="hero-kicker">The Eigenised Gazette</p>
              <h1 className="hero-title">News Article Research</h1>
              <div className="edition-line" aria-label="Newspaper edition metadata">
                <span>Daily proof desk</span>
                <span>Est. 2026</span>
                <span>Adversarial edition</span>
              </div>
              <p className="hero-copy">
                Paste one or many news URLs. The queue gives each article a docket while the main, pro, and contra correspondents work through them one at a time.
              </p>
            </div>
            <div className="hero-actions">
              <div className="stack-md">
                <div className="hero-actions__row">
                  <a
                    aria-label="Open the EigenCloud app dashboard in a new tab"
                    className="hero-action-link"
                    href="https://verify.eigencloud.xyz/app/0x62B98291bdaab3FE0E12b4693e6D79f391501437"
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    View app dashboard
                  </a>
                </div>
                <p className="hero-note">
                  Front-page findings first, with queue progress, prompts, and agent runs preserved as the audit trail below the fold.
                </p>
              </div>
            </div>
          </div>
        </header>

        <div className="panel-grid panel-grid--research">
          <section className={`${SURFACE} section-card section-card--input`}>
            <div className="surface-card__body">
              <div className="section-header">
                <p className="section-kicker">Input</p>
                <h2 className="section-title">Queue article URLs</h2>
                <p className="section-description">Add one URL per line. Each article runs through the same verifiable pro/contra research workflow.</p>
              </div>

              <form className="form-stack" onSubmit={onSubmit}>
                <label className="field-group">
                  <span className="field-label">News article URLs</span>
                  <textarea
                    aria-label="News article URLs"
                    className={`${inputClassName} form-textarea`}
                    onChange={(event) => setArticleUrlsInput(event.target.value)}
                    placeholder={"https://example.com/news/story\nhttps://example.com/news/follow-up"}
                    rows={5}
                    value={articleUrlsInput}
                  />
                </label>

                {status.kind === "client_error" || status.kind === "api_error" ? (
                  <div aria-live="assertive" className="banner banner--danger" role="alert">
                    <p className="banner__title">Research request{status.kind === "api_error" && status.code ? ` · ${status.code}` : ""}</p>
                    <p className="banner__body">{status.message}</p>
                    {status.kind === "api_error" && status.requestId ? (
                      <p className="banner__body">Request ID: <code>{status.requestId}</code>{status.retryable ? " · retryable" : ""}</p>
                    ) : null}
                  </div>
                ) : null}

                {status.kind === "submitting" ? (
                  <p aria-live="polite" className="status-copy">
                    Adding article research jobs to the queue…
                  </p>
                ) : null}
                {hasActiveJobs ? (
                  <p aria-live="polite" className="status-copy">
                    {activeJobIds.length} queued or running job{activeJobIds.length === 1 ? "" : "s"}. Completed results will appear in the docket list.
                  </p>
                ) : null}

                <button className="button-primary" disabled={status.kind === "submitting"} type="submit">
                  {status.kind === "submitting" ? "Queueing…" : "Queue research"}
                </button>

                <ResearchFlow status={status.kind} hasActiveJobs={hasActiveJobs} />
              </form>

              <ResearchQueuePanel jobs={jobs} selectedJobId={displayJob?.id ?? selectedJobId} onSelect={setSelectedJobId} />
            </div>
          </section>

          <section className={`${SURFACE} section-card section-card--results`}>
            <div className="surface-card__body">
              <div className="section-header">
                <p className="section-kicker">Results</p>
                <h2 className="section-title">For and against</h2>
                <p className="section-description">Select a completed queue item to read the perspective-agent output from the same article context.</p>
              </div>

              {response ? (
                <div className="result-stack">
                  <ResultDocket response={response} />
                  <ArticleTracePanel article={response.article} build={response.verifiableBuild} />
                  <div className="perspective-compare" aria-label="Side-by-side perspective comparison">
                    <PerspectivePanel
                      title="For the article"
                      subtitle="Evidence that reinforces the article's framing"
                      tone="support"
                      text={response.proAnalysis}
                    />
                    <PerspectivePanel
                      title="Against the article"
                      subtitle="Evidence that challenges or complicates the framing"
                      tone="challenge"
                      text={response.contraAnalysis}
                    />
                  </div>
                  <PromptProvenancePanel response={response} />
                  <details className="disclosure">
                    <summary className="disclosure__summary">
                      <span className="disclosure__summary-copy">
                        <span className="section-kicker disclosure__summary-kicker">Diagnostics</span>
                        <span className="disclosure__title">Agent prompts and runs</span>
                      </span>
                      <span className="disclosure__meta">JSON payload</span>
                    </summary>
                    <div className="disclosure__content">
                      <pre className="code-block">
                        {JSON.stringify({
                          proPrompt: response.proPrompt,
                          contraPrompt: response.contraPrompt,
                          promptBindings: response.promptBindings,
                          verifiableBuild: response.verifiableBuild,
                          agentRuns: response.agentRuns,
                        }, null, 2)}
                      </pre>
                    </div>
                  </details>
                </div>
              ) : (
                <div className="empty-state">No completed article research yet. Queue one or more URLs to generate both perspectives.</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function ResearchFlow({ status, hasActiveJobs }: { status: ResearchStatus["kind"]; hasActiveJobs: boolean }) {
  const active = status === "submitting" || hasActiveJobs;
  const done = status === "success";
  const attention = status === "client_error" || status === "api_error";
  const steps = [
    ["01", "Queue URL"],
    ["02", "Fetch source"],
    ["03", "Compare lenses"],
    ["04", "Bind proof"],
  ] as const;
  return (
    <ol className={`flow-rail ${active ? "flow-rail--active" : ""} ${done ? "flow-rail--done" : ""} ${attention ? "flow-rail--attention" : ""}`}>
      {steps.map(([number, label]) => (
        <li className="flow-step" key={number}>
          <span className="flow-step__number">{number}</span>
          <span className="flow-step__label">{label}</span>
        </li>
      ))}
    </ol>
  );
}

function ResearchQueuePanel({
  jobs,
  selectedJobId,
  onSelect,
}: {
  jobs: NewsResearchQueueJob[];
  selectedJobId: string | null;
  onSelect: (jobId: string) => void;
}) {
  if (jobs.length === 0) {
    return (
      <div className="queue-panel queue-panel--empty" aria-label="Article research queue">
        Queue multiple article URLs and keep this page open while each job runs.
      </div>
    );
  }

  return (
    <section className="queue-panel" aria-label="Article research queue">
      <div className="queue-panel__header">
        <p className="section-kicker">Queue</p>
        <p className="queue-panel__summary">
          {jobs.filter((job) => job.status === "queued" || job.status === "running").length} active · {jobs.filter((job) => job.status === "succeeded").length} complete
        </p>
      </div>
      <ol className="queue-list">
        {jobs.map((job) => (
          <li className={`queue-item ${selectedJobId === job.id ? "queue-item--selected" : ""}`} key={job.id}>
            <div className="queue-item__main">
              <QueueStatusBadge job={job} />
              <span className="queue-item__url" title={job.articleUrl}>{job.articleUrl}</span>
            </div>
            {job.error ? <p className="queue-item__error">{job.error.message}</p> : null}
            <div className="queue-item__meta">
              <span>Request <code>{job.requestId.slice(0, 8)}</code></span>
              {job.finishedAt ? <span>Finished {formatTime(job.finishedAt)}</span> : job.startedAt ? <span>Started {formatTime(job.startedAt)}</span> : <span>Queued {formatTime(job.createdAt)}</span>}
              {job.status === "succeeded" && job.result ? (
                <button className="queue-item__select" onClick={() => onSelect(job.id)} type="button">
                  {selectedJobId === job.id ? "Viewing result" : "View result"}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function QueueStatusBadge({ job }: { job: NewsResearchQueueJob }) {
  const label = job.status === "queued" && job.position ? `Queued #${job.position}` : labelForQueueStatus(job.status);
  return <span className={`queue-status queue-status--${job.status}`}>{label}</span>;
}

function labelForQueueStatus(status: NewsResearchQueueJob["status"]): string {
  if (status === "running") return "Running";
  if (status === "succeeded") return "Complete";
  if (status === "failed") return "Failed";
  return "Queued";
}

function ResultDocket({ response }: { response: NewsResearchResponse }) {
  const promptCount = response.promptBindings?.length ?? 0;
  const buildLabel = response.verifiableBuild?.environment ?? "local";
  return (
    <section className="results-docket" aria-label="Research run overview">
      <div>
        <p className="results-docket__eyebrow">Research docket</p>
        <h3 className="results-docket__title">One article. Two adversarial readings.</h3>
      </div>
      <dl className="results-docket__stats">
        <div>
          <dt>Source</dt>
          <dd>locked</dd>
        </div>
        <div>
          <dt>Perspectives</dt>
          <dd>pro / contra</dd>
        </div>
        <div>
          <dt>Prompts</dt>
          <dd>{promptCount}</dd>
        </div>
        <div>
          <dt>Build</dt>
          <dd>{buildLabel}</dd>
        </div>
      </dl>
    </section>
  );
}

function PerspectivePanel({
  title,
  subtitle,
  text,
  tone,
}: {
  title: string;
  subtitle: string;
  text: string;
  tone: "support" | "challenge";
}) {
  const lens = tone === "support" ? "Supporting lens" : "Challenging lens";
  return (
    <section className={`result-panel ${tone === "support" ? "result-panel--support" : "result-panel--challenge"}`}>
      <div className="result-panel__header">
        <div>
          <h3 className="result-panel__title">{title}</h3>
          <p className="result-panel__meta">{subtitle}</p>
        </div>
        <span className="lens-badge">{lens}</span>
      </div>
      <ReadingBlock text={text} />
    </section>
  );
}

function ArticleTracePanel({
  article,
  build,
}: {
  article: NewsResearchResponse["article"];
  build?: NewsResearchResponse["verifiableBuild"];
}) {
  const contentHash = article.contentSha256 ?? "unavailable";
  return (
    <section className="trace-panel" aria-label="Source article binding">
      <div className="trace-panel__head">
        <div>
          <p className="trace-panel__kicker">Source article</p>
          <a className="trace-panel__link" href={article.url} rel="noopener noreferrer" target="_blank">
            {article.url}
          </a>
          <p className="trace-panel__subtitle">The same fetched article context is reused by both perspective agents.</p>
        </div>
        <span className="trace-panel__badge">Source locked</span>
      </div>
      <dl className="trace-list">
        <div>
          <dt>Article hash</dt>
          <dd title={contentHash}>{shortHash(contentHash)}</dd>
        </div>
        {typeof article.byteLength === "number" ? (
          <div>
            <dt>Fetched bytes</dt>
            <dd>{article.byteLength.toLocaleString()}</dd>
          </div>
        ) : null}
        {article.fetchedAt ? (
          <div>
            <dt>Fetched at</dt>
            <dd>{article.fetchedAt}</dd>
          </div>
        ) : null}
        {build ? (
          <div>
            <dt>Build</dt>
            <dd title={build.imageDigest}>{build.environment} · {shortHash(build.imageDigest)}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

function PromptProvenancePanel({ response }: { response: NewsResearchResponse }) {
  const bindings = response.promptBindings ?? [];
  const build = response.verifiableBuild;
  if (bindings.length === 0 && !build) return null;

  return (
    <details className="provenance-panel">
      <summary className="provenance-panel__summary">
        <span className="provenance-panel__summary-copy">
          <span className="section-kicker">Perspective provenance</span>
          <span className="section-title section-title--sm">System prompts bound to the verifiable build</span>
          <span className="section-description">
            Open the audit trail for exact prompts, prompt hashes, and build metadata.
          </span>
        </span>
        <span className="provenance-panel__summary-meta">{bindings.length || 0} bound prompts</span>
      </summary>
      <div className="provenance-panel__content">
        {build ? (
          <div className="build-strip">
            <span title={build.commitSha}>Commit {shortHash(build.commitSha)}</span>
            <span title={build.imageDigest}>Image {shortHash(build.imageDigest)}</span>
            <span>{build.environment}</span>
            {build.dashboardUrl ? (
              <a href={build.dashboardUrl} rel="noopener noreferrer" target="_blank">
                Verify build
              </a>
            ) : null}
            {build.promptSourceUrl ? (
              <a href={build.promptSourceUrl} rel="noopener noreferrer" target="_blank">
                Prompt source
              </a>
            ) : (
              <span>{build.promptSourcePath}</span>
            )}
          </div>
        ) : null}
        <ResearchVerificationPanel response={response} />
        {bindings.length > 0 ? (
          <div className="prompt-binding-grid">
            {bindings.map((binding) => (
              <article className="prompt-binding-card" key={binding.role}>
                <div className="prompt-binding-card__head">
                  <span className="prompt-binding-card__role">{labelForRole(binding.role)}</span>
                  <span className="prompt-binding-card__perspective">{formatPerspective(binding.perspective)}</span>
                </div>
                <pre className="prompt-binding-card__prompt">{binding.systemPrompt}</pre>
                {binding.researchPrompt ? (
                  <p className="prompt-binding-card__research">
                    <strong>Generated research prompt:</strong> {binding.researchPrompt}
                  </p>
                ) : null}
                <dl className="prompt-binding-card__hashes">
                  <div>
                    <dt>System prompt</dt>
                    <dd title={binding.systemPromptSha256}>{shortHash(binding.systemPromptSha256)}</dd>
                  </div>
                  <div>
                    <dt>Full prompt</dt>
                    <dd title={binding.promptHash}>{shortHash(binding.promptHash)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function ResearchVerificationPanel({ response }: { response: NewsResearchResponse }) {
  const manifestHash = response.manifest?.manifestSha256;
  if (!manifestHash) return null;
  const packageHref = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(response, null, 2))}`;
  const fileSuffix = shortHash(manifestHash).replace(/[^a-zA-Z0-9]/g, "");
  return (
    <div className="research-verification">
      <div>
        <p className="research-verification__kicker">Signed research package</p>
        <p className="research-verification__hash" title={manifestHash}>{shortHash(manifestHash)}</p>
      </div>
      <a className="research-verification__action" download={`research-${fileSuffix || "manifest"}.json`} href={packageHref}>
        Verify research
      </a>
      <code className="research-verification__command">npx tsx scripts/verify-manifest.ts response.json --refetch --ecloud --strict</code>
    </div>
  );
}

function ReadingBlock({ text, muted = false }: { text: string; muted?: boolean }) {
  const blocks = formatReadingBlocks(text);
  return (
    <div className={`reading-block ${muted ? "reading-block--muted" : ""}`}>
      {blocks.map((block, index) => {
        if (block.kind === "list") {
          return (
            <ul className="reading-block__list" key={`list-${index}`}>
              {block.items.map((item, itemIndex) => <li key={`${index}-${itemIndex}`}>{renderInlineMarkdown(item)}</li>)}
            </ul>
          );
        }
        if (block.kind === "heading") {
          return <h4 className="reading-block__heading" key={`h-${index}`}>{renderInlineMarkdown(block.text)}</h4>;
        }
        if (block.kind === "divider") {
          return <hr className="reading-block__divider" key={`hr-${index}`} />;
        }
        return <p className="reading-block__paragraph" key={`p-${index}`}>{renderInlineMarkdown(block.text)}</p>;
      })}
    </div>
  );
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function normalizeResearchApiError(body: unknown, status: number): ResearchApiError {
  if (isUnknownRecord(body)) {
    const rawError = body.error;
    const code = typeof rawError === "string" ? rawError : `request_failed_${status}`;
    return {
      code,
      message: typeof body.message === "string" ? body.message : messageForResearchErrorCode(code, status),
      requestId: typeof body.requestId === "string" ? body.requestId : null,
      retryable: typeof body.retryable === "boolean" ? body.retryable : null,
    };
  }
  const code = `request_failed_${status}`;
  return { code, message: messageForResearchErrorCode(code, status), requestId: null, retryable: null };
}

function messageForResearchErrorCode(code: string, status: number): string {
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
      return "The queued research job could not be found. It may have expired from the server queue.";
    case "timeout":
      return "The article or agent request timed out. Please retry in a moment.";
    case "network_error":
      return "The article could not be reached from the research service.";
    case "byte_cap_exceeded":
      return "The article is too large for the bounded fetcher.";
    case "research_agent_failed":
      return "A research agent failed before both perspectives were completed. Please retry.";
    default:
      if (code.startsWith("http_")) return `The article request failed upstream (${code}).`;
      return `The research request failed with HTTP ${status}.`;
  }
}

function parseArticleUrls(value: string): string[] {
  return value
    .split(/[\n\r]+/)
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

async function fetchQueueJob(fetchImpl: FetchLike, jobId: string): Promise<NewsResearchQueueJob | null> {
  try {
    const res = await fetchImpl(resolveFrontendApiUrl(`research/jobs/${encodeURIComponent(jobId)}`));
    if (!res.ok) return null;
    const body = await readResponseJson(res);
    return isResearchQueueJob(body) ? body : null;
  } catch {
    return null;
  }
}

function mergeQueueJobs(current: NewsResearchQueueJob[], incoming: NewsResearchQueueJob[]): NewsResearchQueueJob[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((job) => [job.id, job]));
  for (const job of incoming) byId.set(job.id, job);
  return Array.from(byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isQueueEnqueueResponse(value: unknown): value is NewsResearchQueueEnqueueResponse {
  return (
    isUnknownRecord(value) &&
    Array.isArray(value.jobs) &&
    value.jobs.every(isResearchQueueJob) &&
    isUnknownRecord(value.queue) &&
    typeof value.queue.total === "number" &&
    typeof value.queue.active === "number"
  );
}

function isResearchQueueJob(value: unknown): value is NewsResearchQueueJob {
  return (
    isUnknownRecord(value) &&
    typeof value.id === "string" &&
    typeof value.requestId === "string" &&
    typeof value.articleUrl === "string" &&
    (value.status === "queued" || value.status === "running" || value.status === "succeeded" || value.status === "failed") &&
    (typeof value.position === "number" || value.position === null) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (typeof value.startedAt === "string" || value.startedAt === null) &&
    (typeof value.finishedAt === "string" || value.finishedAt === null) &&
    (value.result === null || isNewsResearchResponse(value.result)) &&
    (value.error === null || isResearchQueueError(value.error))
  );
}

function isResearchQueueError(value: unknown): boolean {
  return (
    isUnknownRecord(value) &&
    typeof value.error === "string" &&
    typeof value.message === "string" &&
    typeof value.requestId === "string" &&
    typeof value.retryable === "boolean"
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatReadingBlocks(text: string): FormattedBlock[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const blocks: FormattedBlock[] = [];
  let pendingList: string[] = [];

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      if (pendingList.length > 0) {
        blocks.push({ kind: "list", items: pendingList });
        pendingList = [];
      }
      blocks.push({ kind: "heading", text: heading[2].trim() });
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      if (pendingList.length > 0) {
        blocks.push({ kind: "list", items: pendingList });
        pendingList = [];
      }
      blocks.push({ kind: "divider" });
      continue;
    }

    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (bullet) {
      pendingList.push(bullet[1].trim());
      continue;
    }
    if (pendingList.length > 0) {
      blocks.push({ kind: "list", items: pendingList });
      pendingList = [];
    }
    blocks.push({ kind: "paragraph", text: line });
  }

  if (pendingList.length > 0) blocks.push({ kind: "list", items: pendingList });
  if (blocks.length === 0 && text.trim().length > 0) return [{ kind: "paragraph", text: text.trim() }];
  return blocks;
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const inlinePattern = /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|`[^`\n]+?`|\*[^*\n]+?\*|_[^_\n]+?_)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = inlinePattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));

    const token = match[0];
    const key = `${match.index}-${token}`;
    if ((token.startsWith("**") && token.endsWith("**")) || (token.startsWith("__") && token.endsWith("__"))) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    cursor = match.index + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes.length > 0 ? nodes : [text];
}

function shortHash(value: string): string {
  if (!value || value === "unknown" || value === "unavailable") return value;
  const prefix = value.startsWith("sha256:") ? "sha256:" : "";
  const hash = prefix ? value.slice(prefix.length) : value;
  if (hash.length <= 14) return value;
  return `${prefix}${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

function labelForRole(role: string): string {
  if (role === "main") return "Main planner";
  if (role === "pro") return "Pro perspective";
  return "Contra perspective";
}

function formatPerspective(value: string): string {
  return value.replace(/_/g, " ");
}
