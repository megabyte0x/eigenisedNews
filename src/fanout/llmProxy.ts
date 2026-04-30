import { generateText } from "ai";
import { eigen, createEigenGateway, type EigenGatewayLanguageModel } from "@layr-labs/ai-gateway-provider";
import { POLICY } from "../lib/policy";
import type { StructuredModelOutput } from "../types";

export type CallModelArgs = {
  provider: string;
  model: string;
  prompt: string;
  retries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  modelFactory?: (modelId: string) => EigenGatewayLanguageModel;
};

export type CallModelResult = {
  rawOutput: string;
  latencyMs: number;
};

export async function callModel(args: CallModelArgs): Promise<CallModelResult> {
  const retries = args.retries ?? POLICY.LLM_RETRIES;
  const timeoutMs = args.timeoutMs ?? POLICY.LLM_TIMEOUT_MS;
  const factory = args.modelFactory ?? eigen;
  const modelId = `${args.provider}/${args.model}`;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    args.signal?.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const result = await generateText({
        model: factory(modelId),
        prompt: args.prompt,
        temperature: POLICY.LLM_TEMPERATURE,
        abortSignal: controller.signal,
      });
      const latencyMs = Date.now() - t0;
      if (typeof result.text !== "string") throw new Error("malformed_response");
      return { rawOutput: result.text, latencyMs };
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
    const eigenMatch = e.message.match(/Eigen Gateway API error \((\d+)\)/);
    if (eigenMatch) return `http_${eigenMatch[1]}`;
    const status = (e as { statusCode?: number }).statusCode;
    if (typeof status === "number") return `http_${status}`;
  }
  return "network_error";
}

/**
 * Build a model factory that targets a specific gateway base URL with a custom fetch.
 * Used by tests (mock fetch) and by local dev (no JWT auth needed against ai-gateway-dev).
 */
export function makeTestFactory(opts: { baseURL: string; fetch?: typeof fetch }): (modelId: string) => EigenGatewayLanguageModel {
  return createEigenGateway({ baseURL: opts.baseURL, fetch: opts.fetch });
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
