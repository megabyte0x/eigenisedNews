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

const SURFACE = "rounded-[28px] border border-white/10 bg-black/35 shadow-[0_20px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl";
const inputClassName =
  "w-full rounded-[22px] border border-white/10 bg-white/5 px-4 py-3 text-sm text-[#fff9ec] outline-none transition placeholder:text-[#827866] focus:border-[#f7b267]/60 focus:bg-white/[0.07]";

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
      <div className="min-h-screen bg-[#0b1020] text-[#f3efe3]">
        <div className="mx-auto max-w-7xl px-5 pt-6 sm:px-8 lg:px-12">
          <button className="rounded-full border border-white/15 px-4 py-2 text-sm text-[#f7b267]" onClick={() => setMode("research")} type="button">
            Back to article research
          </button>
        </div>
        <OperatorConsole fetchImpl={fetchImpl} />
      </div>
    );
  }

  const response = status.kind === "success" ? status.response : null;

  return (
    <div className="min-h-screen bg-[#0b1020] text-[#f3efe3]">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-5 py-8 sm:px-8 lg:px-12">
        <header className={`${SURFACE} overflow-hidden`}>
          <div className="grid gap-6 px-6 py-6 sm:px-8 lg:grid-cols-[1.3fr_0.9fr] lg:px-10">
            <div>
              <p className="text-xs uppercase tracking-[0.38em] text-[#f7b267]">EigenCompute news agents</p>
              <h1 className="mt-4 max-w-3xl font-serif text-4xl tracking-tight text-[#fff9ec] sm:text-5xl">
                News article research
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-[#d8d2c2] sm:text-base">
                Send one news URL. The main agent creates pro and contra research prompts, then two perspective agents return evidence-backed analysis.
              </p>
            </div>
            <div className="flex items-start justify-end">
              <button className="rounded-full border border-[#f7b267]/35 px-4 py-2 text-sm text-[#f7b267]" onClick={() => setMode("console")} type="button">
                Open synthesis console
              </button>
            </div>
          </div>
        </header>

        <div className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr]">
          <section className={`${SURFACE} p-6 sm:p-8`}>
            <h2 className="font-serif text-2xl text-[#fff9ec]">Research a URL</h2>
            <p className="mt-1 text-sm text-[#c8c1af]">Use a news article URL so both sides analyze the same source.</p>
            <form className="mt-6 space-y-5" onSubmit={onSubmit}>
              <label className="block">
                <span className="mb-2 block text-xs uppercase tracking-[0.24em] text-[#f7b267]">News article URL</span>
                <input
                  aria-label="News article URL"
                  className={inputClassName}
                  onChange={(event) => setArticleUrl(event.target.value)}
                  placeholder="https://example.com/news/story"
                  value={articleUrl}
                />
              </label>
              {status.kind === "client_error" || status.kind === "api_error" ? (
                <div className="rounded-2xl border border-[#ff7d73]/35 bg-[#ff7d73]/10 px-4 py-3 text-sm text-[#ffd1cb]">
                  {status.message}
                </div>
              ) : null}
              <button
                className="inline-flex w-full items-center justify-center rounded-2xl bg-[#f7b267] px-5 py-3 font-medium text-[#23160a] transition hover:bg-[#ffd199] disabled:cursor-wait disabled:opacity-70"
                disabled={status.kind === "loading"}
                type="submit"
              >
                {status.kind === "loading" ? "Researching…" : "Research both sides"}
              </button>
            </form>
          </section>

          <section className={`${SURFACE} p-6 sm:p-8`}>
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <h2 className="font-serif text-2xl text-[#fff9ec]">For and against</h2>
                <p className="mt-1 text-sm text-[#c8c1af]">Perspective-agent output from the same article context.</p>
              </div>
            </div>
            {response ? (
              <div className="space-y-5">
                <PerspectivePanel title="For the article" text={response.proAnalysis} />
                <PerspectivePanel title="Against the article" text={response.contraAnalysis} />
                <details className="rounded-3xl border border-white/10 bg-[#0d1426] p-4">
                  <summary className="cursor-pointer text-sm text-[#f7b267]">Agent prompts and runs</summary>
                  <pre className="mt-4 overflow-x-auto whitespace-pre-wrap text-xs leading-6 text-[#dce8ff]">
                    {JSON.stringify({ proPrompt: response.proPrompt, contraPrompt: response.contraPrompt, agentRuns: response.agentRuns }, null, 2)}
                  </pre>
                </details>
              </div>
            ) : (
              <div className="rounded-[24px] border border-dashed border-white/15 bg-white/[0.03] p-8 text-sm leading-7 text-[#bdb5a3]">
                No article research yet. Submit a URL to generate both perspectives.
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function PerspectivePanel({ title, text }: { title: string; text: string }) {
  return (
    <section>
      <h3 className="text-xs uppercase tracking-[0.25em] text-[#f7b267]">{title}</h3>
      <pre className="mt-3 whitespace-pre-wrap rounded-3xl border border-white/10 bg-white/5 p-4 text-sm leading-7 text-[#f3efe3]">{text}</pre>
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
