import { describe, test, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../src/index";
import { renderFrontendShell } from "../src/frontend/shell";

describe("frontend shell", () => {
  test("renderFrontendShell defaults to same-origin shell markup", () => {
    const html = renderFrontendShell();

    expect(html).toContain("eigenisedNews operator console");
    expect(html).toContain('/app.js');
    expect(html).toContain('/app.css');
    expect(html).toContain('<script type="application/json" id="frontend-runtime-config">{}');
  });

  test("renderFrontendShell injects runtime config", () => {
    const html = renderFrontendShell({ apiBaseUrl: "https://api.example.com" });

    expect(html).toContain('"apiBaseUrl":"https://api.example.com"');
  });

  test("GET / injects runtime config from FRONTEND_API_BASE_URL", async () => {
    const previous = process.env.FRONTEND_API_BASE_URL;
    process.env.FRONTEND_API_BASE_URL = "https://api.example.com/<script>";

    try {
      const res = await request(buildApp()).get("/");

      expect(res.status).toBe(200);
      expect(res.text).toMatch(/"apiBaseUrl":"https:\/\/api\.example\.com\/\\u003cscript>"/);
    } finally {
      if (previous === undefined) {
        delete process.env.FRONTEND_API_BASE_URL;
      } else {
        process.env.FRONTEND_API_BASE_URL = previous;
      }
    }
  });

  test("renderFrontendShell escapes < in runtime config JSON", () => {
    const html = renderFrontendShell({ apiBaseUrl: "https://example.com/<script>alert(1)</script>" });

    expect(html).toMatch(/https:\/\/example\.com\/\\u003cscript>alert\(1\)\\u003c\/script>/);
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  test("GET / returns the operator console HTML shell", async () => {
    const res = await request(buildApp()).get("/");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("eigenisedNews");
    expect(res.text).toContain("/app.js");
    expect(res.text).toContain("/app.css");
  });
});
