import { useMemo, useState } from "react";
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

const SURFACE = "rounded-[28px] border border-white/10 bg-black/35 shadow-[0_20px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl";

export function OperatorConsole({ fetchImpl = fetch }: OperatorConsoleProps) {
  const [topic, setTopic] = useState("");
  const [urlText, setUrlText] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [includeRaw, setIncludeRaw] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const payload = useMemo(() => buildRequest(topic, urlText, sourceUrl, sourceText), [sourceText, sourceUrl, topic, urlText]);
  const response = status.kind === "success" ? status.response : status.kind === "api_error" ? status.partial : null;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
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
    <div className="min-h-screen bg-[#0b1020] text-[#f3efe3]">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-5 py-8 sm:px-8 lg:px-12">
        <header className={`${SURFACE} overflow-hidden`}>
          <div className="grid gap-6 px-6 py-6 sm:px-8 lg:grid-cols-[1.4fr_0.8fr] lg:px-10">
            <div>
              <p className="text-xs uppercase tracking-[0.38em] text-[#f7b267]">EigenCompute operator console</p>
              <h1 className="mt-4 max-w-3xl font-serif text-4xl tracking-tight text-[#fff9ec] sm:text-5xl">
                eigenisedNews
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-[#d8d2c2] sm:text-base">
                Submit a topic, attach URLs or source text, and inspect the signed consensus manifest without reaching for curl.
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Metric label="endpoint" value="POST /synthesize" />
              <Metric label="models" value="3 fixed" />
              <Metric label="threshold" value="2 of 3" />
              <Metric label="output" value="signed manifest" />
            </dl>
          </div>
        </header>

        <div className="grid gap-8 lg:grid-cols-[0.95fr_1.05fr]">
          <section className={`${SURFACE} p-6 sm:p-8`}>
            <div className="mb-6 flex items-center justify-between gap-4">
              <div>
                <h2 className="font-serif text-2xl text-[#fff9ec]">Compose request</h2>
                <p className="mt-1 text-sm text-[#c8c1af]">Keep inputs precise. Empty rows are ignored before submit.</p>
              </div>
              <span className="rounded-full border border-[#f7b267]/35 px-3 py-1 text-xs uppercase tracking-[0.24em] text-[#f7b267]">
                v1 console
              </span>
            </div>

            <form className="space-y-6" onSubmit={onSubmit}>
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
                  className={`${inputClassName} min-h-28`}
                  value={urlText}
                  onChange={(event) => setUrlText(event.target.value)}
                  placeholder={"One URL per line\nhttps://example.com/report\nhttps://example.com/post"}
                />
              </LabeledField>

              <div className="grid gap-4 md:grid-cols-[0.7fr_1.3fr]">
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
                    className={`${inputClassName} min-h-28`}
                    value={sourceText}
                    onChange={(event) => setSourceText(event.target.value)}
                    placeholder="Paste article text, notes, or transcripts here"
                  />
                </LabeledField>
              </div>

              <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-[#efe7d1]">
                <input
                  aria-label="Include raw model outputs"
                  checked={includeRaw}
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

              <button
                className="inline-flex w-full items-center justify-center rounded-2xl bg-[#f7b267] px-5 py-3 font-medium text-[#23160a] transition hover:bg-[#ffd199] disabled:cursor-wait disabled:opacity-70"
                disabled={status.kind === "loading"}
                type="submit"
              >
                {status.kind === "loading" ? "Running synthesis…" : "Run synthesis"}
              </button>
            </form>
          </section>

          <section className="flex flex-col gap-6">
            <div className={`${SURFACE} p-6 sm:p-8`}>
              <div className="mb-4 flex items-center justify-between gap-4">
                <div>
                  <h2 className="font-serif text-2xl text-[#fff9ec]">Response</h2>
                  <p className="mt-1 text-sm text-[#c8c1af]">Signed output, consensus claims, and model status.</p>
                </div>
                <StatusBadge status={status} />
              </div>

              {response ? (
                <div className="space-y-5">
                  <section>
                    <h3 className="text-xs uppercase tracking-[0.25em] text-[#f7b267]">Brief</h3>
                    <pre className="mt-3 whitespace-pre-wrap rounded-3xl border border-white/10 bg-white/5 p-4 text-sm leading-7 text-[#f3efe3]">
                      {response.manifest.brief || "(brief unavailable)"}
                    </pre>
                  </section>

                  <div className="grid gap-4 xl:grid-cols-2">
                    <ClaimList title="Consensus claims" claims={response.manifest.merge.claims.map((claim) => claim.statement)} />
                    <ClaimList
                      title="Minority perspectives"
                      claims={response.manifest.merge.minorityClaims.map((claim) => claim.statement)}
                    />
                  </div>

                  <section>
                    <h3 className="text-xs uppercase tracking-[0.25em] text-[#f7b267]">Signature</h3>
                    <code className="mt-3 block overflow-x-auto rounded-2xl border border-white/10 bg-[#0d1426] px-4 py-3 text-xs text-[#d9f7e2]">
                      {response.signature}
                    </code>
                  </section>
                </div>
              ) : (
                <div className="rounded-[24px] border border-dashed border-white/15 bg-white/[0.03] p-8 text-sm leading-7 text-[#bdb5a3]">
                  No synthesis response yet. Submit a request to inspect the manifest and model consensus.
                </div>
              )}
            </div>

            <div className={`${SURFACE} p-6 sm:p-8`}>
              <h2 className="font-serif text-2xl text-[#fff9ec]">Manifest diagnostics</h2>
              {response ? (
                <div className="mt-5 space-y-5">
                  <ul className="grid gap-3 text-sm text-[#efe7d1] sm:grid-cols-2">
                    <li className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                      Successful models: <strong>{response.manifest.merge.successfulModels}</strong>
                    </li>
                    <li className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                      Threshold: <strong>{response.manifest.merge.consensusThreshold}</strong>
                    </li>
                    <li className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                      App ID: <strong>{response.manifest.deployment.appId}</strong>
                    </li>
                    <li className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                      Request hash: <strong>{response.manifest.request.requestHash}</strong>
                    </li>
                  </ul>

                  <section>
                    <h3 className="text-xs uppercase tracking-[0.25em] text-[#f7b267]">Model runs</h3>
                    <ul className="mt-3 space-y-3">
                      {response.manifest.models.map((model) => (
                        <li
                          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm"
                          key={`${model.provider}/${model.model}`}
                        >
                          <span>{model.provider}/{model.model}</span>
                          <span className={model.status === "ok" ? "text-[#9af0b2]" : "text-[#ff9f92]"}>{model.status}</span>
                        </li>
                      ))}
                    </ul>
                  </section>

                  {response.raw ? (
                    <details className="rounded-3xl border border-white/10 bg-[#0d1426] p-4">
                      <summary className="cursor-pointer text-sm text-[#f7b267]">Raw model outputs</summary>
                      <pre className="mt-4 overflow-x-auto whitespace-pre-wrap text-xs leading-6 text-[#dce8ff]">
                        {JSON.stringify(response.raw, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>
              ) : (
                <p className="mt-4 text-sm leading-7 text-[#bdb5a3]">Manifest metadata appears here after a request completes.</p>
              )}
            </div>
          </section>
        </div>
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
    <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-4">
      <dt className="text-[11px] uppercase tracking-[0.25em] text-[#a39a83]">{label}</dt>
      <dd className="mt-2 font-serif text-lg text-[#fff9ec]">{value}</dd>
    </div>
  );
}

function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs uppercase tracking-[0.24em] text-[#f7b267]">{label}</span>
      {children}
    </label>
  );
}

function Banner({ title, tone, children }: { title: string; tone: "warning" | "danger"; children: React.ReactNode }) {
  const toneClass = tone === "warning" ? "border-[#f7b267]/35 bg-[#f7b267]/10 text-[#ffe1b7]" : "border-[#ff7d73]/35 bg-[#ff7d73]/10 text-[#ffd1cb]";
  return (
    <div className={`rounded-2xl border px-4 py-3 text-sm ${toneClass}`}>
      <p className="font-medium">{title}</p>
      <p className="mt-1">{children}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  let tone = "bg-white/5 text-[#c9c1af]";
  let label = "idle";

  if (status.kind === "loading") {
    tone = "bg-[#f7b267]/10 text-[#ffd8a1]";
    label = "running";
  } else if (status.kind === "success") {
    tone = "bg-[#90f0b5]/10 text-[#baf4ca]";
    label = "complete";
  } else if (status.kind === "api_error" || status.kind === "client_error") {
    tone = "bg-[#ff7d73]/10 text-[#ffd2cd]";
    label = "attention";
  }
  return <span className={`rounded-full px-3 py-1 text-xs uppercase tracking-[0.25em] ${tone}`}>{label}</span>;
}

function ClaimList({ title, claims }: { title: string; claims: string[] }) {
  return (
    <section>
      <h3 className="text-xs uppercase tracking-[0.25em] text-[#f7b267]">{title}</h3>
      <ul className="mt-3 space-y-3">
        {claims.length === 0 ? (
          <li className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-[#bdb5a3]">(none)</li>
        ) : (
          claims.map((claim) => (
            <li className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm leading-7 text-[#efe7d1]" key={claim}>
              {claim}
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

const inputClassName =
  "w-full rounded-[22px] border border-white/10 bg-white/5 px-4 py-3 text-sm text-[#fff9ec] outline-none transition placeholder:text-[#827866] focus:border-[#f7b267]/60 focus:bg-white/[0.07]";
