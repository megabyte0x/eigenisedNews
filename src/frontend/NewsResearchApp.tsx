import { useState } from "react";
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
  | { kind: "api_error"; message: string }
  | { kind: "success"; response: NewsResearchResponse };

type FormSubmitEvent = { preventDefault: () => void };

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
      const res = await fetchImpl(resolveResearchUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ articleUrl: trimmedArticleUrl }),
      });
      const body = (await res.json()) as NewsResearchResponse | { error: string };
      if (!res.ok) {
        setStatus({ kind: "api_error", message: "error" in body ? body.error : `request_failed_${res.status}` });
        return;
      }
      setStatus({ kind: "success", response: body as NewsResearchResponse });
    } catch (error) {
      setStatus({ kind: "api_error", message: error instanceof Error ? error.message : String(error) });
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
          <section className={`${SURFACE} section-card`}>
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
                    <p className="banner__title">Research request</p>
                    <p className="banner__body">{status.message}</p>
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
              </form>
            </div>
          </section>

          <section className={`${SURFACE} section-card`}>
            <div className="surface-card__body">
              <div className="section-header">
                <p className="section-kicker">Results</p>
                <h2 className="section-title">For and against</h2>
                <p className="section-description">Perspective-agent output from the same article context, styled for reading before diagnostics.</p>
              </div>

              {response ? (
                <div className="result-stack">
                  {response.mainSummary ? (
                    <section className="result-panel">
                      <h3 className="result-panel__title">Editorial brief</h3>
                      <p className="result-panel__meta">Main-agent overview</p>
                      <div className="reading-block reading-block--muted">{response.mainSummary}</div>
                    </section>
                  ) : null}
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
                        {JSON.stringify({ proPrompt: response.proPrompt, contraPrompt: response.contraPrompt, agentRuns: response.agentRuns }, null, 2)}
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
  return (
    <section className={`result-panel ${tone === "support" ? "result-panel--support" : "result-panel--challenge"}`}>
      <h3 className="result-panel__title">{title}</h3>
      <p className="result-panel__meta">{subtitle}</p>
      <div className="reading-block">{text}</div>
    </section>
  );
}

function resolveResearchUrl(): string {
  const runtimeConfig = readFrontendRuntimeConfig();
  if (!runtimeConfig.apiBaseUrl?.trim()) return "/research";
  const base = runtimeConfig.apiBaseUrl.trim().replace(/\/+$/, "") + "/";
  try {
    return new URL("research", base).toString();
  } catch {
    return "/research";
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
