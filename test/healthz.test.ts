import { describe, test, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../src/index";

describe("GET /healthz", () => {
  test("returns 200 and { ok: true }", async () => {
    const res = await request(buildApp()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
