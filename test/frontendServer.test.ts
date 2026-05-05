import { describe, test, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../src/index";

describe("frontend shell", () => {
  test("GET / returns the operator console HTML shell", async () => {
    const res = await request(buildApp()).get("/");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("eigenisedNews");
    expect(res.text).toContain("/app.js");
    expect(res.text).toContain("/app.css");
  });
});
