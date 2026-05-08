import { useState, type ReactNode } from "react";
import { OperatorConsole } from "./OperatorConsole";
import type { NewsResearchResponse } from "../types";

type FetchLike = typeof fetch;

type NewsResearchAppProps = {
  fetchImpl?: FetchLike;
};

type FrontendRuntimeConfig = {
  apiBaseUrl?: string;
};

type ResearchStatus =
  | { kind: "idle" }
  | { kind: "client_error"; message: string }
  | { kind: "loading" }
  | { kind: "api_error"; message: string; code: string | null; requestId: string | null; retryable: boolean | null }
  | { kind: "success"; response: NewsResearchResponse };

type FormSubmitEvent = { preventDefault: () => void };

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
  const [mode, setMode] = useState<"research" | "console">("research");
  const [articleUrl, setArticleUrl] = useState("");
  const [status, setStatus] = useState<ResearchStatus>({ kind: "idle" });

  async function onSubmit(event: FormSubmitEvent) {
    event.preventDefault();
    const trimmedArticleUrl = articleUrl.trim();
    if (!isHttpUrl(trimmedArticleUrl)) {
      setStatus({ kind: "client_error", message: "Enter a valid news article URL before researching." });
      return;
    }

    setStatus({ kind: "loading" });
    try {
      const res = await fetchImpl(resolveResearchUrl({ includeRaw: true }), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ articleUrl: trimmedArticleUrl }),
      });
      const body = await readResponseJson(res);
      if (!res.ok) {
        setStatus({ kind: "api_error", ...normalizeResearchApiError(body, res.status) });
        return;
      }
      setStatus({ kind: "success", response: body as NewsResearchResponse });
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

  if (mode === "console") {
    return (
      <div className="app-shell">
        <div className="app-shell__inner">
          <div className="topbar">
            <button className="button-ghost button-ghost--plain" onClick={() => setMode("research")} type="button">
              Back to article research
            </button>
          </div>
        </div>
        <OperatorConsole fetchImpl={fetchImpl} />
      </div>
    );
  }

  const response = status.kind === "success" ? status.response : null;

  return (
    <div className="app-shell">
      <div className="app-shell__inner app-shell__inner--spacious">
        <header className={`${SURFACE} surface-card--hero`}>
          <div className="surface-card__body surface-card__body--hero hero-grid">
            <div>
              <p className="hero-kicker">EigenCompute news agents</p>
              <h1 className="hero-title">News article research</h1>
              <p className="hero-copy">
                Send one news URL. The main agent creates pro and contra research prompts, then two perspective agents return evidence-backed analysis.
              </p>
            </div>
            <div className="hero-actions">
              <div className="stack-md">
                <div className="hero-actions__row">
                  <button className="button-ghost" onClick={() => setMode("console")} type="button">
                    Open synthesis console
                  </button>
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
                  Reader-first output up front, with prompts and agent runs preserved below for inspection.
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
                <h2 className="section-title">Research a URL</h2>
                <p className="section-description">Use a news article URL so both sides analyze the same source.</p>
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

                {status.kind === "loading" ? (
                  <p aria-live="polite" className="status-copy">
                    Research in progress. Results and diagnostics will appear below.
                  </p>
                ) : null}

                <button className="button-primary" disabled={status.kind === "loading"} type="submit">
                  {status.kind === "loading" ? "Researching…" : "Research both sides"}
                </button>

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
                <div className="empty-state">No article research yet. Submit a URL to generate both perspectives.</div>
              )}
            </div>
          </section>
        </div>
      </div>
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

function resolveResearchUrl(opts: { includeRaw?: boolean } = {}): string {
  const runtimeConfig = readFrontendRuntimeConfig();
  if (!runtimeConfig.apiBaseUrl?.trim()) return opts.includeRaw ? "/research?include=raw" : "/research";
  const base = runtimeConfig.apiBaseUrl.trim().replace(/\/+$/, "") + "/";
  try {
    const url = new URL("research", base);
    if (opts.includeRaw) url.searchParams.set("include", "raw");
    return url.toString();
  } catch {
    return opts.includeRaw ? "/research?include=raw" : "/research";
  }
}

function readFrontendRuntimeConfig(): FrontendRuntimeConfig {
  const script = document.getElementById("frontend-runtime-config");
  if (!script?.textContent) return {};
  try {
    return JSON.parse(script.textContent) as FrontendRuntimeConfig;
  } catch {
    return {};
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function normalizeResearchApiError(body: unknown, status: number): ResearchApiError {
  if (isRecord(body)) {
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

function labelForRole(role: string): string {
  if (role === "main") return "Main planner";
  if (role === "pro") return "Pro perspective";
  return "Contra perspective";
}

function formatPerspective(value: string): string {
  return value.replace(/_/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
