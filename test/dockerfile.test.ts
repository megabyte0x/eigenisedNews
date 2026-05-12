import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

describe("Dockerfile", () => {
  test("copies the frontend build script into the builder stage", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(dockerfile).toContain("COPY scripts ./scripts");
  });

  test("copies the external agent skill into the runtime image", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(dockerfile).toContain("COPY agent-skills ./agent-skills");
    expect(dockerfile).toContain("COPY --from=builder /app/agent-skills ./agent-skills");
  });

  test(".dockerignore keeps the frontend build script available to Docker builds", () => {
    const dockerignore = readFileSync(".dockerignore", "utf8");
    expect(dockerignore.split(/\r?\n/)).not.toContain("scripts");
  });
});
