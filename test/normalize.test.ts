import { describe, test, expect } from "vitest";
import { normalizeClaim } from "../src/merger/normalize";

describe("normalizeClaim", () => {
  test("lowercases and trims", () => {
    expect(normalizeClaim("  The Sky Is Blue  ")).toBe("the sky is blue");
  });
  test("collapses whitespace", () => {
    expect(normalizeClaim("a   b\tc\nd")).toBe("a b c d");
  });
  test("strips trailing punctuation and surrounding quotes", () => {
    expect(normalizeClaim('"Hello, World!"')).toBe("hello, world");
    expect(normalizeClaim("Done.")).toBe("done");
  });
  test("idempotent", () => {
    const s = "Some Claim.";
    expect(normalizeClaim(normalizeClaim(s))).toBe(normalizeClaim(s));
  });
  test("NFKC equivalence", () => {
    // U+FF21 (FULLWIDTH LATIN CAPITAL LETTER A) → "A"
    expect(normalizeClaim("Ａbc")).toBe("abc");
  });
  test("does not strip non-matching outer chars", () => {
    expect(normalizeClaim("'single'")).toBe("'single'");
  });
});
