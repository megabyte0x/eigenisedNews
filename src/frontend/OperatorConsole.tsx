import { useMemo, useState, type ReactNode } from "react";
import type { Manifest, RawModelOutput, SynthesizeSource } from "../types";

type FetchLike = typeof fetch;

type SynthesizeSuccess = {
  manifest: Manifest;
  signature: `0x${string}`;
  raw: RawModelOutput[] | null;
};

type ApiError = {
  error: string;
  manifest?: Manifest;
  signature?: `0x${string}`;
  raw?: RawModelOutput[] | null;
};

type OperatorConsoleProps = {
  fetchImpl?: FetchLike;
};

type FrontendRuntimeConfig = {
  apiBaseUrl?: string;
};

type Status =
  | { kind: "idle" }
  | { kind: "client_error"; message: string }
  | { kind: "loading" }
  | { kind: "api_error"; message: string; partial: SynthesizeSuccess | null }
  | { kind: "success"; response: SynthesizeSuccess };

type SubmitEvent = { preventDefault: () => void };

const SURFACE = "surface-card";
const inputClassName = "form-input";

export function OperatorConsole({ fetchImpl = fetch }: OperatorConsoleProps) {
  const [topic, setTopic] = useState("");
  const [urlText, setUrlText] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [includeRaw, setIncludeRaw] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const payload = useMemo(() => buildRequest(topic, urlText, sourceUrl, sourceText), [sourceText, sourceUrl, topic, urlText]);
  const response = status.kind === "success" ? status.response : status.kind === "api_error" ? status.partial : null;

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    const validation = validateRequest(payload);
    if (validation) {
      setStatus({ kind: "client_error", message: validation });
      return;
    }

    setStatus({ kind: "loading" });

    const path = resolveSynthesizeUrl(includeRaw);
    try {
      const res = await fetchImpl(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as SynthesizeSuccess | ApiError;

      if (!res.ok) {
        setStatus({
          kind: "api_error",
          message: "error" in body ? body.error : `request_failed_${res.status}`,
          partial: isPartialResponse(body) ? body : null,
        });
        return;
      }
      setStatus({ kind: "success", response: body as SynthesizeSuccess });
    } catch (error) {
      setStatus({
        kind: "api_error",
        message: error instanceof Error ? error.message : String(error),
        partial: null,
      });
    }
  }

  return (
    <div className="app-shell__inner app-shell__inner--spacious">
      <header className={`${SURFACE} surface-card--console`}>
        <div className="surface-card__body surface-card__body--hero hero-grid">
          <div>
            <p className="hero-kicker">EigenCompute operator console</p>
            <h1 className="hero-title">eigenisedNews</h1>
            <p className="hero-copy">
              Submit a topic, attach URLs or source text, and inspect the signed consensus manifest without reaching for curl.
            </p>
          </div>
          <dl className="metrics-grid">
            <Metric label="endpoint" value="POST /synthesize" />
            <Metric label="models" value="3 fixed" />
            <Metric label="threshold" value="2 of 3" />
            <Metric label="output" value="signed manifest" />
          </dl>
        </div>
      </header>

      <div className="panel-grid panel-grid--console">
        <section className={`${SURFACE} section-card`}>
          <div className="surface-card__body">
            <div className="section-header section-header--inline">
              <div className="section-header__content">
                <p className="section-kicker">Compose</p>
                <h2 className="section-title">Compose request</h2>
                <p className="section-description">Keep inputs precise. Empty rows are ignored before submit.</p>
              </div>
              <span className="status-pill status-pill--idle">v1 console</span>
            </div>

            <form className="form-stack" onSubmit={onSubmit}>
              <LabeledField label="Topic">
                <input
                  aria-label="Topic"
                  className={inputClassName}
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  placeholder="e.g. Latest EigenLayer AVS launch coverage"
                />
              </LabeledField>

              <LabeledField label="URLs">
                <textarea
                  aria-label="URLs"
                  className={`${inputClassName} form-textarea`}
                  value={urlText}
                  onChange={(event) => setUrlText(event.target.value)}
                  placeholder={"One URL per line\nhttps://example.com/report\nhttps://example.com/post"}
                />
              </LabeledField>

              <div className="source-grid">
                <LabeledField label="Source URL">
                  <input
                    aria-label="Source URL"
                    className={inputClassName}
                    value={sourceUrl}
                    onChange={(event) => setSourceUrl(event.target.value)}
                    placeholder="Optional provenance URL"
                  />
                </LabeledField>
                <LabeledField label="Source text">
                  <textarea
                    aria-label="Source text"
                    className={`${inputClassName} form-textarea`}
                    value={sourceText}
                    onChange={(event) => setSourceText(event.target.value)}
                    placeholder="Paste article text, notes, or transcripts here"
                  />
                </LabeledField>
              </div>

              <label className="checkbox-row">
                <input
                  aria-label="Include raw model outputs"
                  checked={includeRaw}
                  className="checkbox-input"
                  onChange={(event) => setIncludeRaw(event.target.checked)}
                  type="checkbox"
                />
                <span>Include raw model outputs</span>
              </label>

              {status.kind === "client_error" ? (
                <Banner tone="warning" title="Input check">
                  {status.message}
                </Banner>
              ) : null}

              {status.kind === "api_error" ? (
                <Banner tone="danger" title="Synthesis response">
                  {status.message}
                </Banner>
              ) : null}

              {status.kind === "loading" ? (
                <p aria-live="polite" className="status-copy">
                  Synthesis is running. Signed output and diagnostics will populate when the request completes.
                </p>
              ) : null}

              <button className="button-primary" disabled={status.kind === "loading"} type="submit">
                {status.kind === "loading" ? "Running synthesis…" : "Run synthesis"}
              </button>
            </form>
          </div>
        </section>

        <section className="console-stack">
          <div className={`${SURFACE} section-card`}>
            <div className="surface-card__body">
              <div className="section-header section-header--inline">
                <div className="section-header__content">
                  <p className="section-kicker">Output</p>
                  <h2 className="section-title">Response</h2>
                  <p className="section-description">Signed output, consensus claims, and model status.</p>
                </div>
                <StatusBadge status={status} />
              </div>

              {response ? (
                <div className="result-stack">
                  <section className="result-panel result-panel--support">
                    <h3 className="result-panel__title">Brief</h3>
                    <p className="result-panel__meta">Signed synthesis summary</p>
                    <div className="reading-block reading-block--muted">{response.manifest.brief || "(brief unavailable)"}</div>
                  </section>

                  <div className="claim-grid">
                    <ClaimList title="Consensus claims" claims={response.manifest.merge.claims.map((claim) => claim.statement)} />
                    <ClaimList title="Minority perspectives" claims={response.manifest.merge.minorityClaims.map((claim) => claim.statement)} />
                  </div>

                  <section className="result-panel">
                    <h3 className="result-panel__title">Signature</h3>
                    <p className="result-panel__meta">Verifier-facing output</p>
                    <code className="signature-block">{response.signature}</code>
                  </section>
                </div>
              ) : (
                <div className="empty-state">No synthesis response yet. Submit a request to inspect the manifest and model consensus.</div>
              )}
            </div>
          </div>

          <div className={`${SURFACE} section-card`}>
            <div className="surface-card__body">
              <div className="section-header">
                <p className="section-kicker">Diagnostics</p>
                <h2 className="section-title">Manifest diagnostics</h2>
                <p className="section-description">Manifest metadata, model outcomes, and optional raw payloads stay available without crowding the primary response.</p>
              </div>

              {response ? (
                <div className="result-stack">
                  <ul className="diagnostic-grid">
                    <li className="diagnostic-item">
                      Successful models: <strong>{response.manifest.merge.successfulModels}</strong>
                    </li>
                    <li className="diagnostic-item">
                      Threshold: <strong>{response.manifest.merge.consensusThreshold}</strong>
                    </li>
                    <li className="diagnostic-item">
                      App ID: <strong>{response.manifest.deployment.appId}</strong>
                    </li>
                    <li className="diagnostic-item">
                      Request hash: <strong>{response.manifest.request.requestHash}</strong>
                    </li>
                  </ul>

                  <section className="result-panel">
                    <h3 className="result-panel__title">Model runs</h3>
                    <p className="result-panel__meta">Per-model execution outcome</p>
                    <ul className="model-run-list">
                      {response.manifest.models.map((model) => (
                        <li className="model-run-item" key={`${model.provider}/${model.model}`}>
                          <span>
                            {model.provider}/{model.model}
                          </span>
                          <span className={model.status === "ok" ? "model-run-status--ok" : "model-run-status--error"}>{model.status}</span>
                        </li>
                      ))}
                    </ul>
                  </section>

                  {response.raw ? (
                    <details className="disclosure">
                      <summary className="disclosure__summary">
                        <span className="disclosure__summary-copy">
                          <span className="section-kicker disclosure__summary-kicker">Trace</span>
                          <span className="disclosure__title">Raw model outputs</span>
                        </span>
                        <span className="disclosure__meta">JSON payload</span>
                      </summary>
                      <div className="disclosure__content">
                        <pre className="code-block">{JSON.stringify(response.raw, null, 2)}</pre>
                      </div>
                    </details>
                  ) : null}
                </div>
              ) : (
                <div className="empty-state">Manifest metadata appears here after a request completes.</div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function validateRequest(request: { topic: string; urls?: string[]; sources?: SynthesizeSource[] }): string | null {
  if (request.topic.length === 0) return "Enter a topic before running synthesis.";
  if ((request.urls?.length ?? 0) + (request.sources?.length ?? 0) === 0) {
    return "Add at least one URL or source text before running synthesis.";
  }
  return null;
}

function buildRequest(topic: string, urlText: string, sourceUrl: string, sourceText: string): { topic: string; urls?: string[]; sources?: SynthesizeSource[] } {
  const urls = urlText
    .split("\n")
    .map((url) => url.trim())
    .filter(Boolean);
  const sources = sourceText.trim().length > 0 ? [{ ...(sourceUrl.trim() ? { url: sourceUrl.trim() } : {}), text: sourceText.trim() }] : [];

  return {
    topic: topic.trim(),
    ...(urls.length > 0 ? { urls } : {}),
    ...(sources.length > 0 ? { sources } : {}),
  };
}

function resolveSynthesizeUrl(includeRaw: boolean): string {
  const runtimeConfig = readFrontendRuntimeConfig();
  const path = includeRaw ? "synthesize?include=raw" : "synthesize";

  if (!runtimeConfig.apiBaseUrl?.trim()) {
    return `/${path}`;
  }

  const base = runtimeConfig.apiBaseUrl.trim().replace(/\/+$/, "") + "/";

  try {
    return new URL(path, base).toString();
  } catch {
    return `/${path}`;
  }
}

function readFrontendRuntimeConfig(): FrontendRuntimeConfig {
  if (typeof document === "undefined") {
    return {};
  }

  const script = document.getElementById("frontend-runtime-config");
  if (!script?.textContent) {
    return {};
  }

  try {
    return JSON.parse(script.textContent) as FrontendRuntimeConfig;
  } catch {
    return {};
  }
}

function isPartialResponse(value: SynthesizeSuccess | ApiError): value is SynthesizeSuccess {
  return "manifest" in value && "signature" in value;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <dt className="metric-label">{label}</dt>
      <dd className="metric-value">{value}</dd>
    </div>
  );
}

function LabeledField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field-group">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

function Banner({ title, tone, children }: { title: string; tone: "warning" | "danger"; children: ReactNode }) {
  return (
    <div aria-live={tone === "danger" ? "assertive" : "polite"} className={`banner ${tone === "warning" ? "banner--warning" : "banner--danger"}`} role="alert">
      <p className="banner__title">{title}</p>
      <p className="banner__body">{children}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  let tone = "status-pill--idle";
  let label = "idle";

  if (status.kind === "loading") {
    tone = "status-pill--loading";
    label = "running";
  } else if (status.kind === "success") {
    tone = "status-pill--success";
    label = "complete";
  } else if (status.kind === "api_error" || status.kind === "client_error") {
    tone = "status-pill--attention";
    label = "attention";
  }
  return <span className={`status-pill ${tone}`}>{label}</span>;
}

function ClaimList({ title, claims }: { title: string; claims: string[] }) {
  return (
    <section className="result-panel">
      <h3 className="result-panel__title">{title}</h3>
      <p className="result-panel__meta">Claim set</p>
      <ul className="claim-list">
        {claims.length === 0 ? (
          <li className="claim-item claim-item--empty">(none)</li>
        ) : (
          claims.map((claim, index) => (
            <li className="claim-item" key={`${title}-${index}`}>
              {claim}
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
