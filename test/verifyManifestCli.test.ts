import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeGoodResponse } from "./helpers/verifierFixture";

describe("verify-manifest CLI", () => {
  test("offline mode exits 0 for valid response with skipped online checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-cli-"));
    const responsePath = join(dir, "response.json");
    writeFileSync(responsePath, JSON.stringify(await makeGoodResponse()));

    const r = spawnSync("npx", ["tsx", "scripts/verify-manifest.ts", responsePath], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ALL RUNNABLE CHECKS PASSED");
  });

  test("strict mode exits 1 when online checks skip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-cli-"));
    const responsePath = join(dir, "response.json");
    writeFileSync(responsePath, JSON.stringify(await makeGoodResponse()));

    const r = spawnSync("npx", ["tsx", "scripts/verify-manifest.ts", responsePath, "--strict"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("VERIFICATION FAILED");
  });

  test("--provenance-json requires a path argument", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-cli-"));
    const responsePath = join(dir, "response.json");
    writeFileSync(responsePath, JSON.stringify(await makeGoodResponse()));

    const r = spawnSync("npx", ["tsx", "scripts/verify-manifest.ts", responsePath, "--provenance-json"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("usage: verify-manifest.ts");
  });

  test("malformed response shape reports schema failure without crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-cli-"));
    const responsePath = join(dir, "response.json");
    writeFileSync(responsePath, JSON.stringify({ signature: "0x1234", raw: null }));

    const r = spawnSync("npx", ["tsx", "scripts/verify-manifest.ts", responsePath], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Verification report for <invalid manifest>");
    expect(r.stdout).toContain("schema");
    expect(r.stdout).toContain("VERIFICATION FAILED");
    expect(r.stderr).not.toContain("TypeError");
  });
});
