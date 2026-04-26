import { POLICY } from "../lib/policy";
import type { StructuredModelOutput } from "../types";

export type CallModelArgs = {
  proxyUrl: string;
  apiKey: string;
  provider: string;
  model: string;
  prompt: string;
  retries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type CallModelResult = {
  rawOutput: string;
  latencyMs: number;
};

export async function callModel(args: CallModelArgs): Promise<CallModelResult> {
  const retries = args.retries ?? POLICY.LLM_RETRIES;
  const timeoutMs = args.timeoutMs ?? POLICY.LLM_TIMEOUT_MS;
  const url = `${args.proxyUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const body = JSON.stringify({
    provider: args.provider,
    model: args.model,
    messages: [{ role: "user", content: args.prompt }],
    temperature: POLICY.LLM_TEMPERATURE,
  });

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    args.signal?.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${args.apiKey}` },
        body,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - t0;
      if (!res.ok) {
        const err = new Error(`http_${res.status}`);
        if (res.status >= 500 && attempt < retries) {
          lastErr = err;
          continue;
        }
        throw err;
      }
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("malformed_response");
      return { rawOutput: content, latencyMs };
    } catch (e) {
      const code = classifyCallError(e, args.signal);
      lastErr = new Error(code);
      const transient = code === "timeout" || code === "network_error" || code.startsWith("http_5");
      if (!transient || attempt >= retries) throw lastErr;
    } finally {
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onParentAbort);
    }
  }
  throw lastErr ?? new Error("network_error");
}

function classifyCallError(e: unknown, parentSignal: AbortSignal | undefined): string {
  if (e instanceof Error) {
    if (e.name === "AbortError") return parentSignal?.aborted ? "network_error" : "timeout";
    if (e.message.startsWith("http_") || e.message === "malformed_response") return e.message;
  }
  return "network_error";
}

export function parseStructuredOutput(rawOutput: string): StructuredModelOutput {
  const trimmed = rawOutput.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("structured_output_not_pure_json");
  }
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    throw new Error("structured_output_invalid_json");
  }
  if (!obj || typeof obj !== "object") throw new Error("structured_output_not_object");
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.claims)) throw new Error("structured_output_missing_claims");
  if (typeof o.summary !== "string") throw new Error("structured_output_missing_summary");
  const claims: StructuredModelOutput["claims"] = [];
  for (const c of o.claims) {
    if (!c || typeof c !== "object") throw new Error("structured_output_claim_not_object");
    const cc = c as Record<string, unknown>;
    if (typeof cc.statement !== "string") throw new Error("structured_output_claim_statement_not_string");
    if (!Array.isArray(cc.supportingSourceIndices)) throw new Error("structured_output_claim_indices_not_array");
    for (const idx of cc.supportingSourceIndices) {
      if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
        throw new Error("structured_output_claim_index_not_nonneg_integer");
      }
    }
    claims.push({ statement: cc.statement, supportingSourceIndices: cc.supportingSourceIndices as number[] });
  }
  return { claims, summary: o.summary };
}
