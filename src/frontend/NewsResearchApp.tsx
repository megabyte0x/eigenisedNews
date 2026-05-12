import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type {
  NewsResearchQueueEnqueueResponse,
  NewsResearchQueueJob,
  NewsResearchQueueJobStatus,
  NewsResearchQueueListResponse,
  NewsResearchQueueSummary,
  NewsResearchResponse,
  ResearchHistoryEntry,
} from "../types";
import { isUnknownRecord } from "../lib/guards";
import { isNewsResearchResponse, isResearchHistoryResponse } from "../lib/manifestGuards";
import { isHttpUrl } from "../lib/url";
import { OperatorConsole } from "./OperatorConsole";
import { resolveFrontendApiUrl } from "./runtimeConfig";
import type { FetchLike, SubmitEventLike } from "./types";
import type { CheckResult } from "../verifier/types";

type NewsResearchAppProps = {
  fetchImpl?: FetchLike;
};

type ResearchStatus =
  | { kind: "idle" }
  | { kind: "client_error"; message: string }
  | { kind: "loading" }
  | { kind: "api_error"; message: string; code: string | null; requestId: string | null; retryable: boolean | null }
  | { kind: "success"; response: NewsResearchResponse };

type ResearchQueueStatus =
  | { kind: "idle" }
  | { kind: "client_error"; message: string }
  | { kind: "loading"; message: string }
  | { kind: "api_error"; message: string; code: string | null; requestId: string | null; retryable: boolean | null }
  | { kind: "ready"; message: string };

type ResearchApiError = {
  code: string | null;
  message: string;
  requestId: string | null;
  retryable: boolean | null;
};

type ResearchHistoryStatus =
  | { kind: "loading" }
  | { kind: "ready"; entries: ResearchHistoryEntry[] }
  | { kind: "error"; message: string };

type BrowserVerifyCheck = CheckResult & {
  label: string;
  meaning: string;
};

type BrowserVerifyResponse = {
  ok: boolean;
  mode: "browser";
  summary: {
    pass: number;
    fail: number;
    skip: number;
    title: string;
    explanation: string;
  };
  checks: BrowserVerifyCheck[];
};

type BrowserVerifyStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "success"; report: BrowserVerifyResponse }
  | { kind: "error"; message: string };

type FormattedBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "divider" }
  | { kind: "list"; items: string[] };

const SURFACE = "surface-card";
const inputClassName = "form-input";
const HOSTED_AGENT_SKILL_URL = "https://eigenised-news.vercel.app/skill.md";
type AppMode = "research" | "synthesis";
type HeroAudience = "readers" | "agents";

export function NewsResearchApp({ fetchImpl = fetch }: NewsResearchAppProps) {
  const [appMode, setAppMode] = useState<AppMode>("research");
  const [articleUrl, setArticleUrl] = useState("");
  const [heroAudience, setHeroAudience] = useState<HeroAudience>("readers");
  const [status, setStatus] = useState<ResearchStatus>({ kind: "idle" });
  const [queueStatus, setQueueStatus] = useState<ResearchQueueStatus>({ kind: "idle" });
  const [queueSnapshot, setQueueSnapshot] = useState<NewsResearchQueueListResponse | null>(null);
  const [selectedQueuedJobId, setSelectedQueuedJobId] = useState<string | null>(null);
  const [historyStatus, setHistoryStatus] = useState<ResearchHistoryStatus>({ kind: "loading" });
  const lastQueueSuccessCount = useRef(0);
  const researchRequestSeq = useRef(0);

  async function loadHistory() {
    setHistoryStatus((current) => current.kind === "ready" ? current : { kind: "loading" });
    try {
      const res = await fetchImpl(resolveFrontendApiUrl("research/history"));
      const body = await readResponseJson(res);
      if (!res.ok || !isResearchHistoryResponse(body)) {
        setHistoryStatus({ kind: "error", message: "Previous research is not available yet." });
        return;
      }
      setHistoryStatus({ kind: "ready", entries: body.entries });
    } catch (error) {
      setHistoryStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Previous research could not be loaded.",
      });
    }
  }

  function rememberQueueSnapshot(snapshot: NewsResearchQueueListResponse) {
    setQueueSnapshot(snapshot);
    if (snapshot.queue.succeeded > lastQueueSuccessCount.current) {
      lastQueueSuccessCount.current = snapshot.queue.succeeded;
      void loadHistory();
      return;
    }
    lastQueueSuccessCount.current = snapshot.queue.succeeded;
  }

  useEffect(() => {
    let cancelled = false;
    async function loadInitialHistory() {
      try {
        const res = await fetchImpl(resolveFrontendApiUrl("research/history"));
        const body = await readResponseJson(res);
        if (cancelled) return;
        if (!res.ok || !isResearchHistoryResponse(body)) {
          setHistoryStatus({ kind: "error", message: "Previous research is not available yet." });
          return;
        }
        setHistoryStatus({ kind: "ready", entries: body.entries });
      } catch (error) {
        if (cancelled) return;
        setHistoryStatus({
          kind: "error",
          message: error instanceof Error ? error.message : "Previous research could not be loaded.",
        });
      }
    }
    void loadInitialHistory();
    return () => {
      cancelled = true;
    };
  }, [fetchImpl]);

  useEffect(() => {
    let cancelled = false;
    async function loadInitialQueue() {
      try {
        const res = await fetchImpl(resolveFrontendApiUrl("research/jobs"));
        const body = await readResponseJson(res);
        if (cancelled || !res.ok || !isNewsResearchQueueListResponse(body)) return;
        rememberQueueSnapshot(body);
      } catch {
        // The side queue is progressive enhancement; leave the empty state visible if it cannot load.
      }
    }
    void loadInitialQueue();
    return () => {
      cancelled = true;
    };
  }, [fetchImpl]);

  useEffect(() => {
    if (!queueSnapshot?.jobs.some(isActiveQueueJob)) return;
    const timer = window.setInterval(() => {
      void refreshQueue({ silent: true });
    }, 2500);
    return () => {
      window.clearInterval(timer);
    };
  }, [fetchImpl, queueSnapshot?.queue.active]);

  async function onSubmit(event: SubmitEventLike) {
    event.preventDefault();
    const trimmedArticleUrl = articleUrl.trim();
    if (!isHttpUrl(trimmedArticleUrl)) {
      setStatus({ kind: "client_error", message: "Enter a valid news article URL before researching." });
      return;
    }

    setStatus({ kind: "loading" });
    const requestSeq = researchRequestSeq.current + 1;
    researchRequestSeq.current = requestSeq;
    try {
      const res = await fetchImpl(resolveFrontendApiUrl("research", { includeRaw: true }), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ articleUrl: trimmedArticleUrl }),
      });
      const body = await readResponseJson(res);
      if (researchRequestSeq.current !== requestSeq) {
        if (res.ok && isNewsResearchResponse(body)) void loadHistory();
        return;
      }
      if (!res.ok) {
        setStatus({ kind: "api_error", ...normalizeResearchApiError(body, res.status) });
        return;
      }
      if (!isNewsResearchResponse(body)) {
        setStatus({
          kind: "api_error",
          code: "malformed_response",
          message: "The research service returned an unexpected response shape.",
          requestId: null,
          retryable: false,
        });
        return;
      }
      setStatus({ kind: "success", response: body });
      setSelectedQueuedJobId(null);
      void loadHistory();
    } catch (error) {
      if (researchRequestSeq.current !== requestSeq) return;
      setStatus({
        kind: "api_error",
        code: "transport_error",
        message: error instanceof Error ? error.message : String(error),
        requestId: null,
        retryable: true,
      });
    }
  }

  async function onQueueCurrentArticle() {
    const trimmedArticleUrl = articleUrl.trim();
    if (!isHttpUrl(trimmedArticleUrl)) {
      setQueueStatus({ kind: "client_error", message: "Enter a valid news article URL before adding it to the side queue." });
      return;
    }

    setQueueStatus({ kind: "loading", message: "Adding this article to the side queue…" });
    try {
      const res = await fetchImpl(resolveFrontendApiUrl("research/jobs", { includeRaw: true }), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ articleUrl: trimmedArticleUrl }),
      });
      const body = await readResponseJson(res);
      if (!res.ok) {
        setQueueStatus({ kind: "api_error", ...normalizeResearchApiError(body, res.status) });
        return;
      }
      if (!isNewsResearchQueueEnqueueResponse(body)) {
        setQueueStatus({
          kind: "api_error",
          code: "malformed_queue_response",
          message: "The research queue returned an unexpected response shape.",
          requestId: null,
          retryable: true,
        });
        return;
      }
      rememberQueueSnapshot(body);
      const job = body.jobs[0];
      setQueueStatus({
        kind: "ready",
        message: job
          ? `Queued ${hostForUrl(job.articleUrl)}. It will stay in the side rail until it is ready to open.`
          : "Queued article research. Refresh the side rail to inspect the job.",
      });
    } catch (error) {
      setQueueStatus({
        kind: "api_error",
        code: "transport_error",
        message: error instanceof Error ? error.message : String(error),
        requestId: null,
        retryable: true,
      });
    }
  }

  async function refreshQueue(options: { silent?: boolean } = {}) {
    const silent = options.silent === true;
    if (!silent) setQueueStatus({ kind: "loading", message: "Refreshing research queue…" });
    try {
      const res = await fetchImpl(resolveFrontendApiUrl("research/jobs"));
      const body = await readResponseJson(res);
      if (!res.ok) {
        if (!silent) setQueueStatus({ kind: "api_error", ...normalizeResearchApiError(body, res.status) });
        return;
      }
      if (!isNewsResearchQueueListResponse(body)) {
        if (!silent) {
          setQueueStatus({
            kind: "api_error",
            code: "malformed_queue_response",
            message: "The research queue returned an unexpected response shape.",
            requestId: null,
            retryable: true,
          });
        }
        return;
      }
      rememberQueueSnapshot(body);
      if (!silent) setQueueStatus({ kind: "ready", message: "Research queue refreshed." });
    } catch (error) {
      if (!silent) {
        setQueueStatus({
          kind: "api_error",
          code: "transport_error",
          message: error instanceof Error ? error.message : String(error),
          requestId: null,
          retryable: true,
        });
      }
    }
  }

  async function openStoredReport(entry: ResearchHistoryEntry) {
    const requestSeq = researchRequestSeq.current + 1;
    researchRequestSeq.current = requestSeq;
    setStatus({ kind: "loading" });
    try {
      const res = await fetchImpl(resolveFrontendApiUrl(`research/history/${entry.id}`, { includeRaw: true }));
      const body = await readResponseJson(res);
      if (researchRequestSeq.current !== requestSeq) return;
      if (!res.ok || !isNewsResearchResponse(body)) {
        setStatus({
          kind: "api_error",
          code: "stored_report_unavailable",
          message: "The saved article report could not be opened.",
          requestId: null,
          retryable: true,
        });
        return;
      }
      setArticleUrl(body.manifest.request.articleUrl);
      setSelectedQueuedJobId(null);
      setStatus({ kind: "success", response: body });
    } catch (error) {
      if (researchRequestSeq.current !== requestSeq) return;
      setStatus({
        kind: "api_error",
        code: "stored_report_unavailable",
        message: error instanceof Error ? error.message : "The saved article report could not be opened.",
        requestId: null,
        retryable: true,
      });
    }
  }

  function openQueuedJob(job: NewsResearchQueueJob) {
    if (job.status !== "succeeded" || !job.result) return;
    researchRequestSeq.current++;
    setSelectedQueuedJobId(job.id);
    setArticleUrl(job.result.manifest.request.articleUrl);
    setStatus({ kind: "success", response: job.result });
    void loadHistory();
  }

  const response = status.kind === "success" ? status.response : null;
  const hostedSkillUrl = HOSTED_AGENT_SKILL_URL;
  const agentPrompt = buildAgentPrompt(hostedSkillUrl, articleUrl);

  return (
    <div className="app-shell">
      <div className="app-shell__inner app-shell__inner--spacious">
        <AppModeSwitch mode={appMode} onSelect={setAppMode} />

        {appMode === "synthesis" ? (
          <div aria-labelledby="synthesis-console-tab" id="synthesis-console-panel" role="tabpanel">
            <OperatorConsole fetchImpl={fetchImpl} frame="embedded" />
          </div>
        ) : (
          <div aria-labelledby="article-research-tab" className="app-mode-panel" id="article-research-panel" role="tabpanel">
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
                    Send one news URL. The main agent sets the assignment, then pro and contra correspondents file evidence-backed columns from the same source.
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
                    <HeroAudiencePanel
                      mode={heroAudience}
                      onSelect={setHeroAudience}
                      prompt={agentPrompt}
                      skillUrl={hostedSkillUrl}
                    />
                  </div>
                </div>
              </div>
            </header>

            <div className="panel-grid panel-grid--research">
              <section className={`${SURFACE} section-card section-card--input`}>
                <div className="surface-card__body">
                  <div className="section-header">
                    <p className="section-kicker">Input</p>
                    <h2 className="section-title">Research a URL</h2>
                    <p className="section-description">Start one article now, or add one link at a time to the side queue while another report is still running.</p>
                  </div>

                  <form className="form-stack" onSubmit={onSubmit}>
                    <label className="field-group">
                      <span className="field-label">News article URL</span>
                      <input
                        aria-label="News article URL"
                        className={inputClassName}
                        onChange={(event) => setArticleUrl(event.target.value)}
                        placeholder="https://example.com/news/story"
                        value={articleUrl}
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

                    <QueueFeedback queueStatus={queueStatus} />

                    {status.kind === "loading" ? (
                      <p aria-live="polite" className="status-copy">
                        Research in progress. Paste another URL and add it to the queue without interrupting this run.
                      </p>
                    ) : null}

                    <div className="research-actions">
                      <button className="button-primary" disabled={status.kind === "loading"} type="submit">
                        {status.kind === "loading" ? "Researching…" : "Research both sides"}
                      </button>
                      <button
                        className="button-ghost button-ghost--plain queue-enqueue-button"
                        disabled={queueStatus.kind === "loading"}
                        onClick={() => void onQueueCurrentArticle()}
                        type="button"
                      >
                        {queueStatus.kind === "loading" ? "Adding to queue…" : "Add to side queue"}
                      </button>
                    </div>

                    <ResearchFlow status={status.kind} />
                  </form>
                </div>
              </section>

              <section className={`${SURFACE} section-card section-card--results`}>
                <div className="surface-card__body">
                  <div className="section-header">
                    <p className="section-kicker">Results</p>
                    <h2 className="section-title">For and against</h2>
                    <p className="section-description">Perspective-agent output from the same article context, styled for reading before diagnostics.</p>
                  </div>

                  {response ? (
                    <div className="result-stack">
                      <ResultDocket response={response} />
                      <MainSummaryPanel text={response.mainSummary} />
                      <ArticleTracePanel article={response.article} build={response.verifiableBuild} />
                      <VerificationGuidePanel fetchImpl={fetchImpl} response={response} />
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
                    <div className="empty-state">No article research yet. Submit a URL to generate both perspectives.</div>
                  )}
                </div>
              </section>

              <aside className={`${SURFACE} section-card section-card--queue`} aria-label="Queued article research side rail">
                <div className="surface-card__body">
                  <QueueSnapshotPanel
                    queueSnapshot={queueSnapshot}
                    queueStatus={queueStatus}
                    selectedJobId={selectedQueuedJobId}
                    onOpenJob={openQueuedJob}
                    onRefresh={() => void refreshQueue()}
                  />
                  <PreviousResearchPanel
                    historyStatus={historyStatus}
                    onOpen={openStoredReport}
                    selectedManifestHash={response?.manifest.manifestSha256 ?? null}
                  />
                </div>
              </aside>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AppModeSwitch({ mode, onSelect }: { mode: AppMode; onSelect: (mode: AppMode) => void }) {
  return (
    <div className="mode-switch mode-switch--app" role="tablist" aria-label="Application mode">
      <button
        aria-controls="article-research-panel"
        aria-selected={mode === "research"}
        className={`mode-switch__button ${mode === "research" ? "mode-switch__button--active" : ""}`}
        id="article-research-tab"
        onClick={() => onSelect("research")}
        role="tab"
        type="button"
      >
        Article research
      </button>
      <button
        aria-controls="synthesis-console-panel"
        aria-selected={mode === "synthesis"}
        className={`mode-switch__button ${mode === "synthesis" ? "mode-switch__button--active" : ""}`}
        id="synthesis-console-tab"
        onClick={() => onSelect("synthesis")}
        role="tab"
        type="button"
      >
        Open synthesis console
      </button>
    </div>
  );
}

function buildAgentPrompt(skillUrl: string, articleUrl: string): string {
  const targetArticle = articleUrl.trim() || "<ARTICLE_URL>";
  return `Use the following skill \`${skillUrl}\` and research on this article ${targetArticle}`;
}

function HeroAudiencePanel({
  mode,
  onSelect,
  prompt,
  skillUrl,
}: {
  mode: HeroAudience;
  onSelect: (mode: HeroAudience) => void;
  prompt: string;
  skillUrl: string;
}) {
  return (
    <div className="hero-audience">
      <div className="hero-audience__tabs" role="tablist" aria-label="Header audience tools">
        <button
          aria-controls="hero-readers-panel"
          aria-selected={mode === "readers"}
          className={`hero-audience__tab ${mode === "readers" ? "hero-audience__tab--active" : ""}`}
          id="hero-readers-tab"
          onClick={() => onSelect("readers")}
          role="tab"
          type="button"
        >
          Readers
        </button>
        <button
          aria-controls="hero-agents-panel"
          aria-selected={mode === "agents"}
          className={`hero-audience__tab ${mode === "agents" ? "hero-audience__tab--active" : ""}`}
          id="hero-agents-tab"
          onClick={() => onSelect("agents")}
          role="tab"
          type="button"
        >
          For Agents
        </button>
      </div>

      {mode === "agents" ? (
        <div
          aria-labelledby="hero-agents-tab"
          className="hero-note hero-note--agents"
          id="hero-agents-panel"
          role="tabpanel"
        >
          <span className="hero-note__eyebrow">Agent handoff</span>
          <p className="hero-note__copy">Copy this into an autonomous agent to use the hosted paid-research skill.</p>
          <pre className="hero-agent-prompt"><code>{prompt}</code></pre>
          <a className="hero-agent-skill-link" href={skillUrl} rel="noopener noreferrer" target="_blank">
            Open hosted SKILL.md
          </a>
        </div>
      ) : (
        <p
          aria-labelledby="hero-readers-tab"
          className="hero-note"
          id="hero-readers-panel"
          role="tabpanel"
        >
          Front-page findings first, with prompts and agent runs preserved as the audit trail below the fold.
        </p>
      )}
    </div>
  );
}

function ResearchFlow({ status }: { status: ResearchStatus["kind"] }) {
  const active = status === "loading";
  const done = status === "success";
  const attention = status === "client_error" || status === "api_error";
  const steps = [
    ["01", "Lock one source"],
    ["02", "Split two prompts"],
    ["03", "Compare lenses"],
    ["04", "Bind provenance"],
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

function QueueFeedback({ queueStatus }: { queueStatus: ResearchQueueStatus }) {
  if (queueStatus.kind === "client_error" || queueStatus.kind === "api_error") {
    return (
      <div aria-live="assertive" className={`banner ${queueStatus.kind === "client_error" ? "banner--warning" : "banner--danger"}`} role="alert">
        <p className="banner__title">Queue request{queueStatus.kind === "api_error" && queueStatus.code ? ` · ${queueStatus.code}` : ""}</p>
        <p className="banner__body">{queueStatus.message}</p>
        {queueStatus.kind === "api_error" && queueStatus.requestId ? (
          <p className="banner__body">Request ID: <code>{queueStatus.requestId}</code>{queueStatus.retryable ? " · retryable" : ""}</p>
        ) : null}
      </div>
    );
  }

  if (queueStatus.kind === "loading" || queueStatus.kind === "ready") {
    return <p aria-live="polite" className="status-copy">{queueStatus.message}</p>;
  }

  return (
    <p className="status-copy">
      The side queue accepts one URL per click and keeps working even while the main research panel is busy.
    </p>
  );
}

function QueueSnapshotPanel({
  queueSnapshot,
  queueStatus,
  selectedJobId,
  onOpenJob,
  onRefresh,
}: {
  queueSnapshot: NewsResearchQueueListResponse | null;
  queueStatus: ResearchQueueStatus;
  selectedJobId: string | null;
  onOpenJob: (job: NewsResearchQueueJob) => void;
  onRefresh: () => void;
}) {
  const activeCount = queueSnapshot?.queue.active ?? 0;
  const isLoading = queueStatus.kind === "loading";

  if (!queueSnapshot) {
    return (
      <section className="queue-status-panel" aria-label="Research queue status">
        <div className="queue-status-panel__head">
          <div>
            <p className="section-kicker">Side queue</p>
            <h3 className="section-title section-title--sm">Queued articles</h3>
          </div>
          <button className="button-ghost button-ghost--plain queue-refresh-button" disabled={isLoading} onClick={onRefresh} type="button">
            Refresh
          </button>
        </div>
        <p className="queue-status-panel__copy">
          Add a URL from the input card. Finished reports will appear here and can be opened in the results pane.
        </p>
        <div className="queue-status-panel__empty">No queue snapshot loaded yet.</div>
      </section>
    );
  }

  const jobs = queueSnapshot.jobs.slice(0, 12);
  return (
    <section className="queue-status-panel" aria-label="Research queue status">
      <div className="queue-status-panel__head">
        <div>
          <p className="section-kicker">Side queue</p>
          <h3 className="section-title section-title--sm">Queued articles</h3>
        </div>
        <div className="queue-status-panel__head-actions">
          <span className={`queue-status-panel__badge ${activeCount > 0 ? "queue-status-panel__badge--active" : ""}`}>
            {activeCount > 0 ? `${activeCount} active` : "Idle"}
          </span>
          <button className="button-ghost button-ghost--plain queue-refresh-button" disabled={isLoading} onClick={onRefresh} type="button">
            Refresh
          </button>
        </div>
      </div>
      <p className="queue-status-panel__copy">
        Ready cards are clickable. Open one to present that signed research report in the main results pane.
      </p>
      <QueueSummary queue={queueSnapshot.queue} />
      {jobs.length === 0 ? (
        <p className="queue-status-panel__empty">No queued research jobs yet.</p>
      ) : (
        <ol className="queue-job-list">
          {jobs.map((job) => (
            <li className="queue-job-list__item" key={job.id}>
              <QueueJobCard job={job} selected={selectedJobId === job.id} onOpen={onOpenJob} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function QueueSummary({ queue }: { queue: NewsResearchQueueSummary }) {
  const items = [
    ["Queued", queue.queued],
    ["Running", queue.running],
    ["Succeeded", queue.succeeded],
    ["Failed", queue.failed],
    ["Concurrency", queue.concurrency],
    ["Stored", queue.storage],
  ] as const;
  return (
    <dl className="queue-summary-grid">
      {items.map(([label, value]) => (
        <div className="queue-summary-item" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function QueueJobCard({ job, selected, onOpen }: { job: NewsResearchQueueJob; selected: boolean; onOpen: (job: NewsResearchQueueJob) => void }) {
  const canOpen = job.status === "succeeded" && !!job.result;
  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!canOpen) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen(job);
  }

  return (
    <article
      aria-current={selected ? "true" : undefined}
      className={`queue-job-card queue-job-card--${job.status} ${canOpen ? "queue-job-card--clickable" : ""} ${selected ? "queue-job-card--selected" : ""}`}
      onClick={canOpen ? () => onOpen(job) : undefined}
      onKeyDown={handleKeyDown}
      role={canOpen ? "button" : undefined}
      tabIndex={canOpen ? 0 : undefined}
    >
      <div className="queue-job-card__head">
        <div>
          <span className="queue-job-card__host">{hostForUrl(job.articleUrl)}</span>
          <p className="queue-job-card__url">{job.articleUrl}</p>
        </div>
        <span className={`queue-job-card__status queue-job-card__status--${job.status}`}>{formatQueueStatus(job.status)}</span>
      </div>
      <div className="queue-job-card__meta">
        {job.position ? <span>Position {job.position}</span> : null}
        <span title={job.requestId}>Request {shortHash(job.requestId)}</span>
        <span>Updated {formatQueueDate(job.updatedAt)}</span>
      </div>
      {job.result ? <p className="queue-job-card__preview">{trimPreview(job.result.mainSummary || job.result.proAnalysis || job.result.contraAnalysis)}</p> : null}
      {job.error ? <p className="queue-job-card__error">{job.error.message}</p> : null}
      {canOpen ? <span className="queue-job-card__action">Open result</span> : null}
    </article>
  );
}

function PreviousResearchPanel({
  historyStatus,
  onOpen,
  selectedManifestHash,
}: {
  historyStatus: ResearchHistoryStatus;
  onOpen: (entry: ResearchHistoryEntry) => void;
  selectedManifestHash: string | null;
}) {
  return (
    <section className="history-panel" aria-label="Previously researched articles">
      <div className="history-panel__head">
        <div>
          <p className="section-kicker">Library</p>
          <h3 className="section-title section-title--sm">Previous researched articles</h3>
        </div>
        <span className="history-panel__badge">Persistent</span>
      </div>
      <p className="history-panel__copy">
        Saved on EigenCompute persistent storage so duplicate links reuse the existing report. Click any article to read it instantly.
      </p>
      {historyStatus.kind === "loading" ? (
        <p className="history-panel__state">Loading saved reports…</p>
      ) : null}
      {historyStatus.kind === "error" ? (
        <p className="history-panel__state history-panel__state--warning">{historyStatus.message}</p>
      ) : null}
      {historyStatus.kind === "ready" && historyStatus.entries.length === 0 ? (
        <p className="history-panel__state">No saved reports yet. Your first successful research run will appear here.</p>
      ) : null}
      {historyStatus.kind === "ready" && historyStatus.entries.length > 0 ? (
        <ol className="history-list">
          {historyStatus.entries.slice(0, 8).map((entry) => {
            const selected = selectedManifestHash === entry.manifestSha256;
            return (
              <li className="history-list__item" key={entry.id}>
                <button
                  aria-current={selected ? "true" : undefined}
                  className={`history-card ${selected ? "history-card--selected" : ""}`}
                  onClick={() => onOpen(entry)}
                  type="button"
                >
                  <span className="history-card__host">{entry.articleHost}</span>
                  <span className="history-card__url">{entry.articleUrl}</span>
                  {entry.summaryPreview ? <span className="history-card__summary">{entry.summaryPreview}</span> : null}
                  <span className="history-card__meta">
                    <span title={entry.manifestSha256}>Manifest {shortHash(entry.manifestSha256)}</span>
                    <span>{formatHistoryDate(entry.researchedAt)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
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
          <dd>pro / contra / summary</dd>
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

function MainSummaryPanel({ text }: { text: string }) {
  return (
    <section className="main-summary-panel" aria-label="Main agent summary">
      <div className="main-summary-panel__header">
        <div>
          <p className="main-summary-panel__eyebrow">Main agent summary</p>
          <h3 className="main-summary-panel__title">Where the pro and contra takes meet</h3>
        </div>
        <span className="main-summary-panel__badge">Synthesis</span>
      </div>
      <ReadingBlock text={text} />
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
            <dd title={metadataTitle(build.imageDigest)}>{build.environment} · {buildMetadataValue("image", build.imageDigest)}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

function VerificationGuidePanel({ response, fetchImpl }: { response: NewsResearchResponse; fetchImpl: FetchLike }) {
  const [verifyStatus, setVerifyStatus] = useState<BrowserVerifyStatus>({ kind: "idle" });
  const manifestHash = response.manifest?.manifestSha256;
  const build = response.verifiableBuild;
  const promptCount = response.promptBindings?.length ?? 0;
  const rawPromptCount = response.raw?.agentOutputs.length ?? 0;

  async function onVerify() {
    setVerifyStatus({ kind: "checking" });
    try {
      const res = await fetchImpl(resolveFrontendApiUrl("verify"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response }),
      });
      const body = await readResponseJson(res);
      if (!isBrowserVerifyResponse(body)) {
        setVerifyStatus({ kind: "error", message: "The verifier returned an unexpected response." });
        return;
      }
      setVerifyStatus({ kind: "success", report: body });
    } catch (error) {
      setVerifyStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "The browser verifier could not run.",
      });
    }
  }

  const checks = [
    {
      label: "Same article",
      value: response.article.contentSha256 ? shortHash(response.article.contentSha256) : "not hashable",
      copy: "Both agents analyze the same fetched article context, so the disagreement is about interpretation rather than input drift.",
    },
    {
      label: "Prompt record",
      value: `${promptCount} bound`,
      copy: "The planner, pro, contra, and summary instructions are visible below and their hashes are signed into the manifest.",
    },
    {
      label: "Exact run input",
      value: rawPromptCount > 0 ? `${rawPromptCount} prompts` : "raw missing",
      copy: rawPromptCount > 0
        ? "This response includes the full prompt each agent ran with, ready for the browser verifier."
        : "Raw prompts and outputs are not included in this response, so the exact-run check will be limited.",
    },
    {
      label: "Build proof",
      value: build ? buildMetadataValue("commit", build.commitSha) : "not provided",
      copy: "The EigenCloud dashboard link ties the run back to the deployed app, image digest, commit, and agent address when available.",
    },
  ];

  return (
    <section className="verification-guide" aria-label="Verification guide">
      <div className="verification-guide__header">
        <div>
          <p className="section-kicker">Verification guide</p>
          <h3 className="section-title section-title--sm">What the proof means</h3>
          <p className="section-description">
            Verification does not choose a winner between the pro and contra opinions. It shows exactly which article, prompts, outputs, signed manifest, and verifiable build produced them.
          </p>
        </div>
        {manifestHash ? <span className="verification-guide__seal" title={manifestHash}>Manifest {shortHash(manifestHash)}</span> : null}
      </div>
      <div className="verification-guide__checks">
        {checks.map((check) => (
          <article className="verification-check" key={check.label}>
            <p className="verification-check__label">{check.label}</p>
            <p className="verification-check__value">{check.value}</p>
            <p className="verification-check__copy">{check.copy}</p>
          </article>
        ))}
      </div>
      {build ? <BuildStrip build={build} /> : null}
      <ResearchVerificationPanel manifestHash={manifestHash} onVerify={onVerify} status={verifyStatus} />
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
        {build ? <BuildStrip build={build} /> : null}
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
                <AgentRunEvidence response={response} role={binding.role} />
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

function BuildStrip({ build }: { build: NewsResearchResponse["verifiableBuild"] }) {
  return (
    <div className="build-strip" aria-label="Verifiable build metadata">
      <span className={metadataChipClass(build.commitSha)} title={metadataTitle(build.commitSha)}>
        {buildMetadataValue("commit", build.commitSha)}
      </span>
      <span className={metadataChipClass(build.imageDigest)} title={metadataTitle(build.imageDigest)}>
        {buildMetadataValue("image", build.imageDigest)}
      </span>
      <span>{build.environment}</span>
      {build.dashboardUrl ? (
        <a className="build-strip__verify" href={build.dashboardUrl} rel="noopener noreferrer" target="_blank">
          Verify build ↗
        </a>
      ) : (
        <span className="build-strip__muted">No dashboard link</span>
      )}
      {build.promptSourceUrl ? (
        <a className="build-strip__source" href={build.promptSourceUrl} rel="noopener noreferrer" target="_blank">
          Prompt source
        </a>
      ) : (
        <span title={build.promptSourcePath}>{build.promptSourcePath}</span>
      )}
    </div>
  );
}

function AgentRunEvidence({ response, role }: { response: NewsResearchResponse; role: NewsResearchResponse["promptBindings"][number]["role"] }) {
  const run = response.agentRuns.find((candidate) => candidate.role === role);
  const raw = response.raw?.agentOutputs.find((candidate) => candidate.role === role);
  if (!run && !raw) return null;

  return (
    <div className="agent-run-evidence">
      <div className="agent-run-evidence__meta">
        {run ? <span>{run.provider}/{run.model}</span> : null}
        {run ? <span>Status {run.status}</span> : null}
        {run?.rawOutputSha256 ? <span title={run.rawOutputSha256}>Output {shortHash(run.rawOutputSha256)}</span> : null}
      </div>
      {raw ? (
        <details className="agent-run-evidence__prompt">
          <summary>Exact prompt sent to this agent</summary>
          <pre>{raw.prompt}</pre>
        </details>
      ) : (
        <p className="agent-run-evidence__missing">Exact prompt is available when this report is generated with audit data enabled.</p>
      )}
    </div>
  );
}

function ResearchVerificationPanel({
  manifestHash,
  onVerify,
  status,
}: {
  manifestHash: string | undefined;
  onVerify: () => void;
  status: BrowserVerifyStatus;
}) {
  if (!manifestHash) return null;
  return (
    <div className="research-verification">
      <div>
        <p className="research-verification__kicker">Browser verification</p>
        <p className="research-verification__hash" title={manifestHash}>{shortHash(manifestHash)}</p>
        <p className="research-verification__copy">
          Check the signed manifest, agent signature, displayed outputs, and exact agent-run payload right here. No terminal command or file download needed.
        </p>
      </div>
      <button className="research-verification__action" disabled={status.kind === "checking"} onClick={onVerify} type="button">
        {status.kind === "checking" ? "Verifying…" : "Verify this result"}
      </button>
      <BrowserVerificationResult status={status} />
    </div>
  );
}

function BrowserVerificationResult({ status }: { status: BrowserVerifyStatus }) {
  if (status.kind === "idle") {
    return <p className="research-verification__note">Runs an instant integrity check against the current result.</p>;
  }
  if (status.kind === "checking") {
    return <p className="research-verification__note" aria-live="polite">Running browser verification…</p>;
  }
  if (status.kind === "error") {
    return <p className="research-verification__note research-verification__note--fail" role="alert">{status.message}</p>;
  }

  const report = status.report;
  return (
    <div className={`browser-verify browser-verify--${report.ok ? "ok" : "fail"}`} aria-live="polite">
      <div className="browser-verify__summary">
        <strong>{report.summary.title}</strong>
        <span>{report.summary.pass} passed · {report.summary.fail} failed · {report.summary.skip} not checked</span>
        <p>{report.summary.explanation}</p>
      </div>
      <ul className="browser-verify__checks">
        {report.checks.map((check) => (
          <li className={`browser-verify__check browser-verify__check--${check.status}`} key={check.name}>
            <span className="browser-verify__check-status">{labelForCheckStatus(check.status)}</span>
            <span>
              <strong>{check.label}</strong>
              <small>{check.meaning}</small>
            </span>
          </li>
        ))}
      </ul>
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

function isBrowserVerifyResponse(value: unknown): value is BrowserVerifyResponse {
  if (!isUnknownRecord(value) || typeof value.ok !== "boolean" || value.mode !== "browser") return false;
  const summary = value.summary;
  return (
    isUnknownRecord(summary) &&
    typeof summary.pass === "number" &&
    typeof summary.fail === "number" &&
    typeof summary.skip === "number" &&
    typeof summary.title === "string" &&
    typeof summary.explanation === "string" &&
    Array.isArray(value.checks) &&
    value.checks.every(isBrowserVerifyCheck)
  );
}

function isBrowserVerifyCheck(value: unknown): value is BrowserVerifyCheck {
  return (
    isUnknownRecord(value) &&
    typeof value.name === "string" &&
    (value.status === "pass" || value.status === "fail" || value.status === "skip") &&
    typeof value.detail === "string" &&
    typeof value.label === "string" &&
    typeof value.meaning === "string"
  );
}

function isNewsResearchQueueEnqueueResponse(value: unknown): value is NewsResearchQueueEnqueueResponse {
  return (
    isUnknownRecord(value) &&
    Array.isArray(value.jobs) &&
    value.jobs.every(isNewsResearchQueueJob) &&
    isNewsResearchQueueSummary(value.queue)
  );
}

function isNewsResearchQueueListResponse(value: unknown): value is NewsResearchQueueListResponse {
  return isNewsResearchQueueEnqueueResponse(value);
}

function isNewsResearchQueueJob(value: unknown): value is NewsResearchQueueJob {
  if (!isUnknownRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.requestId === "string" &&
    typeof value.articleUrl === "string" &&
    isNewsResearchQueueJobStatus(value.status) &&
    (typeof value.position === "number" || value.position === null) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (typeof value.startedAt === "string" || value.startedAt === null) &&
    (typeof value.finishedAt === "string" || value.finishedAt === null) &&
    (value.result === null || isNewsResearchResponse(value.result)) &&
    (value.error === null || isNewsResearchQueueError(value.error))
  );
}

function isNewsResearchQueueJobStatus(value: unknown): value is NewsResearchQueueJobStatus {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed";
}

function isNewsResearchQueueError(value: unknown): boolean {
  return (
    isUnknownRecord(value) &&
    typeof value.error === "string" &&
    typeof value.message === "string" &&
    typeof value.requestId === "string" &&
    typeof value.retryable === "boolean" &&
    (!("article" in value) || value.article === undefined || isQueueArticle(value.article))
  );
}

function isQueueArticle(value: unknown): boolean {
  return (
    isUnknownRecord(value) &&
    typeof value.url === "string" &&
    (typeof value.contentSha256 === "string" || value.contentSha256 === null) &&
    (!("fetchedAt" in value) || typeof value.fetchedAt === "string" || value.fetchedAt === undefined) &&
    typeof value.byteLength === "number" &&
    (typeof value.error === "string" || value.error === null)
  );
}

function isNewsResearchQueueSummary(value: unknown): value is NewsResearchQueueSummary {
  return (
    isUnknownRecord(value) &&
    typeof value.queued === "number" &&
    typeof value.running === "number" &&
    typeof value.succeeded === "number" &&
    typeof value.failed === "number" &&
    typeof value.active === "number" &&
    typeof value.total === "number" &&
    typeof value.concurrency === "number" &&
    typeof value.maxJobs === "number" &&
    (value.storage === "memory" || value.storage === "file")
  );
}

function isActiveQueueJob(job: NewsResearchQueueJob): boolean {
  return job.status === "queued" || job.status === "running";
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

function formatHistoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatQueueDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatQueueStatus(status: NewsResearchQueueJobStatus): string {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "succeeded") return "Succeeded";
  return "Failed";
}

function hostForUrl(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "article";
  }
}

function trimPreview(value: string): string {
  const normalized = value
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= 150) return normalized;
  return `${normalized.slice(0, 147)}…`;
}

function isKnownMetadata(value: string | null | undefined): value is string {
  const normalized = value?.trim().toLowerCase();
  return !!normalized && normalized !== "unknown" && normalized !== "unavailable" && normalized !== "null";
}

function buildMetadataValue(kind: "commit" | "image", value: string): string {
  const label = kind === "commit" ? "Commit" : "Image";
  return isKnownMetadata(value) ? `${label} ${shortHash(value)}` : `${label} not provided`;
}

function metadataTitle(value: string): string {
  return isKnownMetadata(value) ? value : "Deployment metadata was not provided by the runtime environment.";
}

function metadataChipClass(value: string): string {
  return isKnownMetadata(value) ? "build-strip__chip" : "build-strip__chip build-strip__chip--missing";
}

function labelForCheckStatus(status: CheckResult["status"]): string {
  if (status === "pass") return "Pass";
  if (status === "fail") return "Fail";
  return "Not checked";
}

function labelForRole(role: string): string {
  if (role === "main") return "Main planner";
  if (role === "pro") return "Pro perspective";
  if (role === "contra") return "Contra perspective";
  if (role === "main_summary") return "Main summary";
  return role.replace(/_/g, " ");
}

function formatPerspective(value: string): string {
  return value.replace(/_/g, " ");
}
