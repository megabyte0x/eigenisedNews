import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

describe("Dockerfile", () => {
  test("copies the frontend build script into the builder stage", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(dockerfile).toContain("COPY scripts ./scripts");
  });
});
