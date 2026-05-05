import { describe, expect, test } from "vitest";
import { assertLiveE2eResponse, buildLiveE2eRequest, buildSynthesizeUrl } from "../scripts/live-e2e.mjs";

describe("live e2e helpers", () => {
  test("buildLiveE2eRequest trims values and omits empty fields", () => {
    expect(
      buildLiveE2eRequest({
        topic: "  EigenLayer update  ",
        sourceText: "  body text  ",
        sourceUrl: "  https://example.com/post  ",
        urls: [" https://example.com/a ", "", "https://example.com/b "],
      })
    ).toEqual({
      topic: "EigenLayer update",
      urls: ["https://example.com/a", "https://example.com/b"],
      sources: [{ url: "https://example.com/post", text: "body text" }],
    });
  });

  test("buildSynthesizeUrl adds include=raw for live verification", () => {
    expect(buildSynthesizeUrl("https://example.com")).toBe("https://example.com/synthesize?include=raw");
  });

  test("assertLiveE2eResponse requires thresholdMet and raw outputs", () => {
    expect(() =>
      assertLiveE2eResponse({
        manifest: {
          merge: { thresholdMet: false },
        },
        signature: "0xabc",
        raw: null,
      })
    ).toThrow(/threshold/);
  });
});
