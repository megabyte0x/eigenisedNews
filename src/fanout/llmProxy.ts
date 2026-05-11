import { APICallError, Output, generateText, jsonSchema } from "ai";
import { eigen, createEigenGateway, type EigenGatewayLanguageModel } from "@layr-labs/ai-gateway-provider";
import { isUnknownRecord } from "../lib/guards";
import { sha256Hex } from "../lib/hash";
import { POLICY } from "../lib/policy";
import type { StructuredModelOutput } from "../types";

export type CallModelArgs = {
  provider: string;
  model: string;
  prompt: string;
  retries?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  modelFactory?: (modelId: string) => EigenGatewayLanguageModel;
  onDebugInfo?: (info: CallErrorDebugInfo) => void;
};

export type CallModelResult = {
  rawOutput: string;
  latencyMs: number;
};

export type CallErrorDebugInfo = {
  code: string;
  provider: string;
  model: string;
  statusCode?: number;
  url?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  data?: unknown;
  message?: string;
  errorName?: string;
  errorConstructor?: string;
  errorFields?: Record<string, unknown>;
  rawOutputSha256?: string;
  rawOutputByteLength?: number;
  rawOutput?: string;
};

const STRUCTURED_MODEL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          statement: { type: "string" },
          supportingSourceIndices: {
            type: "array",
            items: { type: "integer", minimum: 0 },
          },
        },
        required: ["statement", "supportingSourceIndices"],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
  },
  required: ["claims", "summary"],
  additionalProperties: false,
} as const;

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
        maxOutputTokens: args.maxOutputTokens,
        abortSignal: controller.signal,
      });
      if (typeof result.text !== "string") throw new Error("malformed_response");
      if (result.text.trim().length === 0) {
        const recoveredOutput = shouldRecoverBlankTextForOpus(args.provider, args.model)
          ? recoverOpusAssistantPayload(result)
          : null;
        if (recoveredOutput !== null) {
          return { rawOutput: recoveredOutput, latencyMs: Date.now() - t0 };
        }

        const structuredFallbackOutput = shouldRecoverBlankTextForOpus(args.provider, args.model)
          ? await invokeOpusStructuredOutputFallback({
            factory,
            modelId,
            prompt: args.prompt,
            abortSignal: controller.signal,
          })
          : null;
        if (structuredFallbackOutput !== null) {
          return { rawOutput: structuredFallbackOutput, latencyMs: Date.now() - t0 };
        }

        throw createEmptyResponseError(args.provider, args.model, result.text);
      }
      return { rawOutput: result.text, latencyMs: Date.now() - t0 };
    } catch (e) {
      const code = classifyCallError(e, args.signal);
      const debugInfo = buildCallErrorDebugInfo(e, args, code);
      if (debugInfo) args.onDebugInfo?.(debugInfo);
      lastErr = debugInfo ? new Error(code, { cause: debugInfo }) : new Error(code);
      const transient = code === "timeout" || code === "network_error" || code === "empty_response" || code.startsWith("http_5");
      if (!transient || attempt >= retries) throw lastErr;
    } finally {
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onParentAbort);
    }
  }
  throw lastErr ?? new Error("network_error");
}

export function extractCallErrorDebugInfo(error: unknown): CallErrorDebugInfo | null {
  if (!(error instanceof Error) || !isCallErrorDebugInfo(error.cause)) return null;
  return error.cause;
}

function classifyCallError(e: unknown, parentSignal: AbortSignal | undefined): string {
  if (e instanceof Error) {
    if (e.name === "AbortError") return parentSignal?.aborted ? "network_error" : "timeout";
    if (e.message.startsWith("http_") || e.message === "malformed_response" || e.message === "empty_response") return e.message;
    const eigenMatch = e.message.match(/Eigen Gateway API error \((\d+)\)/);
    if (eigenMatch) return `http_${eigenMatch[1]}`;
    if (hasStatusCode(e)) return `http_${e.statusCode}`;
  }
  return "network_error";
}

export function buildCallErrorDebugInfo(error: unknown, args: Pick<CallModelArgs, "provider" | "model">, code: string): CallErrorDebugInfo | null {
  if (error instanceof Error && isCallErrorDebugInfo(error.cause)) {
    return error.cause;
  }
  if (args.provider !== "openai" || args.model !== "gpt-4o" || !code.startsWith("http_400")) return null;
  if (APICallError.isInstance(error)) {
    return {
      code,
      provider: args.provider,
      model: args.model,
      statusCode: error.statusCode,
      url: error.url,
      responseHeaders: error.responseHeaders,
      responseBody: error.responseBody,
      data: error.data,
      message: error.message,
    };
  }

  return {
    code,
    provider: args.provider,
    model: args.model,
    statusCode: readErrorStatusCode(error),
    message: error instanceof Error ? error.message : String(error),
    errorName: error instanceof Error ? error.name : undefined,
    errorConstructor: error instanceof Error ? error.constructor.name : undefined,
    errorFields: readErrorFields(error),
  };
}

/**
 * Build a model factory that targets a specific gateway base URL with a custom fetch.
 * Used by tests (mock fetch) and by local dev (no JWT auth needed against ai-gateway-dev).
 */
export function makeTestFactory(opts: { baseURL: string; fetch?: typeof fetch }): (modelId: string) => EigenGatewayLanguageModel {
  return createEigenGateway({ baseURL: opts.baseURL, fetch: opts.fetch });
}

export function parseStructuredOutput(rawOutput: string): StructuredModelOutput {
  const trimmed = extractStructuredOutputJson(rawOutput);
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    throw new Error("structured_output_invalid_json");
  }
  if (!isUnknownRecord(obj)) throw new Error("structured_output_not_object");
  if (!Array.isArray(obj.claims)) throw new Error("structured_output_missing_claims");
  if (typeof obj.summary !== "string") throw new Error("structured_output_missing_summary");
  const claims: StructuredModelOutput["claims"] = [];
  for (const c of obj.claims) {
    if (!isUnknownRecord(c)) throw new Error("structured_output_claim_not_object");
    if (typeof c.statement !== "string") throw new Error("structured_output_claim_statement_not_string");
    claims.push({ statement: c.statement, supportingSourceIndices: parseSupportingSourceIndices(c.supportingSourceIndices) });
  }
  return { claims, summary: obj.summary };
}

export function extractStructuredOutputJson(rawOutput: string): string {
  const trimmed = rawOutput.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenced = extractJsonFenceBody(trimmed);
  if (fenced !== null) return fenced;

  const wrapped = extractSingleWrappedJsonObject(trimmed);
  if (wrapped !== null) return wrapped;

  throw new Error("structured_output_not_pure_json");
}

function extractJsonFenceBody(trimmed: string): string | null {
  const fences = collectJsonFenceBodies(trimmed);
  if (fences.length === 0) return null;
  if (fences.length !== 1) throw new Error("structured_output_not_pure_json");
  const candidate = fences[0];
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
    throw new Error("structured_output_not_pure_json");
  }
  return candidate;
}

function extractSingleWrappedJsonObject(trimmed: string): string | null {
  const candidates = collectTopLevelJsonObjects(trimmed);
  if (candidates.length !== 1) return null;

  const { start, end } = candidates[0];
  return trimmed.slice(start, end + 1);
}

function collectJsonFenceBodies(text: string): string[] {
  const bodies: string[] = [];
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fencePattern)) {
    const language = match[1].trim().toLowerCase();
    if (language !== "" && language !== "json") continue;
    bodies.push(match[2].trim());
  }
  return bodies;
}

function collectTopLevelJsonObjects(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === "\\") {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (ch === "}") {
      if (depth === 0) return [];
      depth--;
      if (depth === 0) {
        ranges.push({ start, end: i });
        start = -1;
      }
    }
  }

  return depth === 0 && !inString ? ranges : [];
}

function hasStatusCode(value: unknown): value is Error & { statusCode: number } {
  return value instanceof Error && "statusCode" in value && typeof value.statusCode === "number";
}

function shouldRecoverBlankTextForOpus(provider: string, model: string): boolean {
  return provider === "anthropic" && model === "claude-opus-4.7";
}

function recoverOpusAssistantPayload(result: {
  content?: unknown;
  response?: { body?: unknown };
  steps?: unknown;
}): string | null {
  return extractCandidatePayloadFromContent(result.content)
    ?? extractCandidatePayloadFromResponseBody(result.response?.body)
    ?? extractCandidatePayloadFromSteps(result.steps);
}

async function invokeOpusStructuredOutputFallback(args: {
  factory: (modelId: string) => EigenGatewayLanguageModel;
  modelId: string;
  prompt: string;
  abortSignal: AbortSignal;
}): Promise<string | null> {
  try {
    const result = await generateText({
      model: args.factory(args.modelId),
      prompt: args.prompt,
      temperature: POLICY.LLM_TEMPERATURE,
      abortSignal: args.abortSignal,
      output: Output.object({
        name: "StructuredNewsSynthesis",
        description: "Structured news synthesis response.",
        schema: jsonSchema(STRUCTURED_MODEL_OUTPUT_SCHEMA),
      }),
      providerOptions: {
        anthropic: {
          structuredOutputMode: "jsonTool",
        },
      },
    });

    const fromOutput = normalizeStructuredOutputValue(await result.output);
    if (fromOutput !== null) return fromOutput;

    if (typeof result.text === "string") {
      const normalizedText = normalizeStructuredOutputRawOutput(result.text);
      if (normalizedText !== null) return normalizedText;
    }

    const recoveredOutput = recoverOpusAssistantPayload(result);
    return recoveredOutput === null ? null : normalizeStructuredOutputRawOutput(recoveredOutput);
  } catch {
    return null;
  }
}

function normalizeStructuredOutputValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(parseStructuredOutput(JSON.stringify(value)));
  } catch {
    return null;
  }
}

function normalizeStructuredOutputRawOutput(rawOutput: string): string | null {
  try {
    return JSON.stringify(parseStructuredOutput(rawOutput));
  } catch {
    return null;
  }
}

function extractCandidatePayloadFromSteps(steps: unknown): string | null {
  if (!Array.isArray(steps)) return null;

  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (!isUnknownRecord(step)) continue;

    const fromContent = extractCandidatePayloadFromContent(step.content);
    if (fromContent !== null) return fromContent;

    const fromBody = isUnknownRecord(step.response)
      ? extractCandidatePayloadFromResponseBody(step.response.body)
      : null;
    if (fromBody !== null) return fromBody;
  }

  return null;
}

function extractCandidatePayloadFromContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;

  const textParts = content
    .map((part) => extractTextPart(part))
    .filter((part): part is string => part !== null);
  if (textParts.length === 0) return null;

  const candidate = textParts.join("");
  return candidate.trim().length > 0 ? candidate : null;
}

function extractCandidatePayloadFromResponseBody(body: unknown): string | null {
  if (typeof body === "string") return body.trim().length > 0 ? body : null;
  if (!isUnknownRecord(body)) return null;

  return extractCandidatePayloadFromContent(body.content)
    ?? extractCandidatePayloadFromMessage(body.message)
    ?? extractCandidatePayloadFromMessages(body.messages);
}

function extractCandidatePayloadFromMessages(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = extractCandidatePayloadFromMessage(messages[i]);
    if (candidate !== null) return candidate;
  }

  return null;
}

function extractCandidatePayloadFromMessage(message: unknown): string | null {
  if (!isUnknownRecord(message)) return null;

  if (typeof message.content === "string") {
    return message.content.trim().length > 0 ? message.content : null;
  }

  return extractCandidatePayloadFromContent(message.content);
}

function extractTextPart(part: unknown): string | null {
  if (!isUnknownRecord(part)) return null;
  if (part.type !== "text" || typeof part.text !== "string") return null;
  return part.text;
}

function readErrorStatusCode(value: unknown): number | undefined {
  if (hasStatusCode(value)) return value.statusCode;
  if (!isUnknownRecord(value) || typeof value.statusCode !== "number") return undefined;
  return value.statusCode;
}

function readErrorFields(value: unknown): Record<string, unknown> | undefined {
  if (!(value instanceof Error) && !isUnknownRecord(value)) return undefined;
  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function isCallErrorDebugInfo(value: unknown): value is CallErrorDebugInfo {
  return isUnknownRecord(value)
    && typeof value.code === "string"
    && typeof value.provider === "string"
    && typeof value.model === "string";
}

function createEmptyResponseError(provider: string, model: string, rawOutput: string): Error {
  return new Error("empty_response", {
    cause: {
      code: "empty_response",
      provider,
      model,
      rawOutputSha256: sha256Hex(rawOutput),
      rawOutputByteLength: Buffer.byteLength(rawOutput, "utf8"),
      rawOutput,
    } satisfies CallErrorDebugInfo,
  });
}

function parseSupportingSourceIndices(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error("structured_output_claim_indices_not_array");
  return value.map((idx) => {
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
      throw new Error("structured_output_claim_index_not_nonneg_integer");
    }
    return idx;
  });
}
