import { describe, test, expect } from "vitest";
import { PROMPT_TEMPLATE, PROMPT_TEMPLATE_HASH, renderPrompt } from "../src/fanout/structuredPrompt";

describe("structuredPrompt", () => {
  test("PROMPT_TEMPLATE_HASH is sha256-prefixed and stable", () => {
    expect(PROMPT_TEMPLATE_HASH.startsWith("sha256:")).toBe(true);
    expect(PROMPT_TEMPLATE_HASH).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("PROMPT_TEMPLATE forbids markdown and mentions JSON shape", () => {
    expect(PROMPT_TEMPLATE.toLowerCase()).toContain("json");
    expect(PROMPT_TEMPLATE.toLowerCase()).toMatch(/no.{0,10}markdown|forbid.{0,20}fence|no.{0,10}code fence/);
    expect(PROMPT_TEMPLATE).toContain("supportingSourceIndices");
  });

  test("renderPrompt embeds topic and indexed inputs", () => {
    const { text } = renderPrompt("breaking news", [{ text: "first source" }, { text: "second source" }]);
    expect(text).toContain("breaking news");
    expect(text).toContain("[0] first source");
    expect(text).toContain("[1] second source");
    expect(text.startsWith(PROMPT_TEMPLATE)).toBe(true);
  });

  test("renderPrompt is deterministic per (topic, inputs)", () => {
    const a = renderPrompt("t", [{ text: "x" }]);
    const b = renderPrompt("t", [{ text: "x" }]);
    expect(a.hash).toBe(b.hash);
    expect(a.text).toBe(b.text);
  });

  test("different topic → different hash", () => {
    const a = renderPrompt("a", [{ text: "x" }]);
    const b = renderPrompt("b", [{ text: "x" }]);
    expect(a.hash).not.toBe(b.hash);
  });

  test("different inputs → different hash", () => {
    const a = renderPrompt("t", [{ text: "x" }]);
    const b = renderPrompt("t", [{ text: "y" }]);
    expect(a.hash).not.toBe(b.hash);
  });
});
