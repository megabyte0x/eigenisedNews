import { describe, test, expect } from "vitest";
import request from "supertest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/index";
import { loadDotEnvFile } from "../src/lib/env";

describe("GET /healthz", () => {
  test("returns 200 and { ok: true }", async () => {
    const res = await request(buildApp()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test("rejects partial dependency overrides instead of silently omitting routes", () => {
    expect(() => buildApp({} as never)).toThrow(/buildApp deps missing/);
  });

  test("rejects invalid EIGEN_ENVIRONMENT when production dependencies are built", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalPrivateKey = process.env.AGENT_PRIVATE_KEY;
    const originalEigenEnvironment = process.env.EIGEN_ENVIRONMENT;
    process.env.NODE_ENV = "development";
    process.env.AGENT_PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
    process.env.EIGEN_ENVIRONMENT = "bogus";
    try {
      expect(() => buildApp()).toThrow(/EIGEN_ENVIRONMENT/);
    } finally {
      restoreEnv("NODE_ENV", originalNodeEnv);
      restoreEnv("AGENT_PRIVATE_KEY", originalPrivateKey);
      restoreEnv("EIGEN_ENVIRONMENT", originalEigenEnvironment);
    }
  });

  test("loads AGENT_PRIVATE_KEY from a local .env file without overriding explicit env", () => {
    const dir = mkdtempSync(join(tmpdir(), "eigenised-news-env-"));
    writeFileSync(
      join(dir, ".env"),
      "AGENT_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000001\nPORT=4123\n"
    );

    const originalPrivateKey = process.env.AGENT_PRIVATE_KEY;
    const originalPort = process.env.PORT;
    delete process.env.AGENT_PRIVATE_KEY;
    process.env.PORT = "9999";

    try {
      const loaded = loadDotEnvFile(dir);
      expect(loaded).toBe(true);
      expect(process.env.AGENT_PRIVATE_KEY).toBe("0x0000000000000000000000000000000000000000000000000000000000000001");
      expect(process.env.PORT).toBe("9999");
    } finally {
      restoreEnv("AGENT_PRIVATE_KEY", originalPrivateKey);
      restoreEnv("PORT", originalPort);
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
