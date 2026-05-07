import { sha256Hex, type Sha256 } from "../lib/hash";

export const PROMPT_TEMPLATE = `You are a neutral news synthesis assistant. You will be given a topic and a numbered list of source documents (indexed from 0). Extract atomic factual claims that the sources support.

Output STRICT JSON with this exact shape and no other content (no markdown, no code fences, no prose, no commentary):
{"claims":[{"statement":"<short atomic claim>","supportingSourceIndices":[<0-indexed integers into the inputs list>]}],"summary":"<one-paragraph neutral summary>"}

Rules:
- Each claim's statement is one short factual sentence in plain text.
- supportingSourceIndices contains 0-indexed integers into the inputs list (each input is labeled "[N] <text>").
- Only include claims that are supported by at least one of the provided sources; do not invent facts.
- The summary is neutral, factual, and one paragraph.
- Do not output anything outside the JSON object.`;

export const PROMPT_TEMPLATE_HASH: Sha256 = sha256Hex(PROMPT_TEMPLATE);

const OPENAI_GPT4O_PROMPT_MAX_CHARS = 40_000;
const OPENAI_GPT4O_INPUT_MAX_CHARS = 2_500;

export function renderPrompt(topic: string, inputs: { text: string }[]): { text: string; hash: Sha256 } {
  const lines = [PROMPT_TEMPLATE, "", `Topic: ${topic}`, "", "Inputs:"];
  for (let i = 0; i < inputs.length; i++) {
    lines.push(`[${i}] ${inputs[i].text}`);
  }
  const text = lines.join("\n");
  return { text, hash: sha256Hex(text) };
}

export function renderPromptForModel(args: {
  provider: string;
  model: string;
  topic: string;
  inputs: { text: string }[];
}): { text: string; hash: Sha256 } {
  const fullPrompt = renderPrompt(args.topic, args.inputs);
  if (!shouldCompactForGpt4o(args.provider, args.model, fullPrompt.text)) return fullPrompt;
  return renderPrompt(args.topic, args.inputs.map(({ text }) => ({ text: compactForGpt4o(text) })));
}

function shouldCompactForGpt4o(provider: string, model: string, promptText: string): boolean {
  return provider === "openai" && model === "gpt-4o" && promptText.length > OPENAI_GPT4O_PROMPT_MAX_CHARS;
}

function compactForGpt4o(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= OPENAI_GPT4O_INPUT_MAX_CHARS) return normalized;
  return `${normalized.slice(0, OPENAI_GPT4O_INPUT_MAX_CHARS)}\n...[truncated for openai/gpt-4o context window: kept first ${OPENAI_GPT4O_INPUT_MAX_CHARS} of ${normalized.length} normalized chars]`;
}
