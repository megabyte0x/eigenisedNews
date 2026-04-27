function deepFreeze<T>(o: T): T {
  Object.freeze(o);
  if (o && typeof o === "object") {
    for (const v of Object.values(o as Record<string, unknown>)) {
      if (v && (typeof v === "object" || typeof v === "function") && !Object.isFrozen(v)) {
        deepFreeze(v);
      }
    }
  }
  return o;
}

export const POLICY = deepFreeze({
  RULESET_VERSION: "v1",
  SCHEMA_VERSION: "1",

  MODEL_SET: [
    { provider: "anthropic", model: "claude-sonnet-4.6", version: "v1" },
    { provider: "anthropic", model: "claude-opus-4.7",   version: "v1" },
    { provider: "openai",    model: "gpt-4o",             version: "v1" },
    { provider: "google",    model: "gemini-2.5-pro",     version: "v1" },
  ],
  MIN_SUCCESS_COUNT: 3,

  FETCH_TIMEOUT_MS: 8_000,
  FETCH_MAX_BYTES: 2_000_000,
  FETCH_RETRIES: 1,
  FETCH_USER_AGENT: "eigenisedNews/1 (+verify.eigencloud.xyz)",

  LLM_TIMEOUT_MS: 45_000,
  LLM_RETRIES: 1,
  LLM_TEMPERATURE: 0,

  MAX_INPUTS: 12,
  MAX_INPUT_BYTES: 2_000_000,
  MAX_TOPIC_LEN: 512,
} as const);

export type ModelSpec = (typeof POLICY.MODEL_SET)[number];

export const providerModelKey = (m: { provider: string; model: string }) => `${m.provider}/${m.model}`;
