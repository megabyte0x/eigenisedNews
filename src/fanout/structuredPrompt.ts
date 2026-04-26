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

export function renderPrompt(topic: string, inputs: { text: string }[]): { text: string; hash: Sha256 } {
  const lines = [PROMPT_TEMPLATE, "", `Topic: ${topic}`, "", "Inputs:"];
  for (let i = 0; i < inputs.length; i++) {
    lines.push(`[${i}] ${inputs[i].text}`);
  }
  const text = lines.join("\n");
  return { text, hash: sha256Hex(text) };
}
