import { describe, test, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../src/index";

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
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
