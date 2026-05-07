import { isUnknownArray, isUnknownRecord } from "./guards";

function deepFreeze<T>(o: T): T {
  Object.freeze(o);
  for (const v of nestedValues(o)) {
    if (v && (typeof v === "object" || typeof v === "function") && !Object.isFrozen(v)) {
      deepFreeze(v);
    }
  }
  return o;
}

function nestedValues(value: unknown): readonly unknown[] {
  if (isUnknownArray(value)) return value;
  if (isUnknownRecord(value)) return Object.values(value);
  return [];
}

export const POLICY = deepFreeze({
  RULESET_VERSION: "v1",
  SCHEMA_VERSION: "1",

  MODEL_SET: [
    { provider: "anthropic", model: "claude-sonnet-4.6", version: "v1" },
    { provider: "openai", model: "gpt-4o", version: "v1" },
    { provider: "google", model: "gemini-2.5-pro", version: "v1" },
  ],
  MIN_SUCCESS_COUNT: 2,

  FETCH_TIMEOUT_MS: 8_000,
  FETCH_MAX_BYTES: 2_000_000,
  FETCH_RETRIES: 1,
  FETCH_USER_AGENT: "eigenisedNews/1 (+verify.eigencloud.xyz)",

  RESEARCH_ARTICLE_CONTEXT_MAX_CHARS: 8_000,
  RESEARCH_LLM_TIMEOUT_MS: 120_000,
  RESEARCH_LLM_MAX_OUTPUT_TOKENS: 900,

  LLM_TIMEOUT_MS: 45_000,
  LLM_RETRIES: 1,
  LLM_TEMPERATURE: 0,

  MAX_INPUTS: 12,
  MAX_TOPIC_LEN: 512,
} as const);

export type ModelSpec = (typeof POLICY.MODEL_SET)[number];

export const providerModelKey = (m: { provider: string; model: string }) => `${m.provider}/${m.model}`;
