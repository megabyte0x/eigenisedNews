import { describe, test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchUrl, hashText } from "../src/fetchers/sourceFetcher";
import { isUnknownRecord } from "../src/lib/guards";
import { parseUnknownJson } from "../src/lib/json";

let server: http.Server;
let baseUrl: string;
let flakyHits = 0;
let firecrawlRequests: unknown[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/ok") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello world");
      return;
    }
    if (url.pathname === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      const huge = Buffer.alloc(3_000_000, 0x41);
      res.end(huge);
      return;
    }
    if (url.pathname === "/500") {
      res.writeHead(500);
      res.end("err");
      return;
    }
    if (url.pathname === "/404") {
      res.writeHead(404);
      res.end("nope");
      return;
    }
    if (url.pathname === "/hang") {
      // never respond
      return;
    }
    if (url.pathname === "/flaky") {
      flakyHits++;
      if (flakyHits === 1) { res.writeHead(500); res.end("err"); return; }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok-on-retry");
      return;
    }
    if (url.pathname === "/firecrawl-fails") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("direct fallback text");
      return;
    }
    if (url.pathname === "/blocked-article") {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("blocked");
      return;
    }
    if (url.pathname === "/v2/scrape") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const parsed = parseUnknownJson(body);
        firecrawlRequests.push(parsed);
        const requestedUrl = extractRequestUrl(parsed);
        if (requestedUrl.endsWith("/firecrawl-fails")) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "upstream unavailable" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          data: {
            markdown: "# Firecrawl article\n\nRecovered article text.",
            metadata: { sourceURL: `${baseUrl}/blocked-article`, statusCode: 200 },
          },
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("fetchUrl", () => {
  test("happy path: contentSha256 + byteLength + text match", async () => {
    const r = await fetchUrl(`${baseUrl}/ok`);
    expect(r.kind).toBe("url");
    expect(r.error).toBeNull();
    expect(r.text).toBe("hello world");
    expect(r.byteLength).toBe(11);
    expect(r.contentSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("404 → http_404 (no retry)", async () => {
    const r = await fetchUrl(`${baseUrl}/404`);
    expect(r.error).toBe("http_404");
    expect(r.contentSha256).toBeNull();
    expect(r.byteLength).toBe(0);
  });

  test("500 retried then succeeds via retry on /flaky", async () => {
    flakyHits = 0;
    const r = await fetchUrl(`${baseUrl}/flaky`, { retries: 1 });
    expect(r.error).toBeNull();
    expect(r.text).toBe("ok-on-retry");
    expect(flakyHits).toBe(2);
  });

  test("500 with retries=0 fails fast", async () => {
    const r = await fetchUrl(`${baseUrl}/500`, { retries: 0 });
    expect(r.error).toBe("http_500");
  });

  test("timeout → 'timeout'", async () => {
    const r = await fetchUrl(`${baseUrl}/hang`, { timeoutMs: 200, retries: 0 });
    expect(r.error).toBe("timeout");
  });

  test("oversize → 'byte_cap_exceeded'", async () => {
    const r = await fetchUrl(`${baseUrl}/big`, { maxBytes: 1024, retries: 0 });
    expect(r.error).toBe("byte_cap_exceeded");
    expect(r.contentSha256).toBeNull();
  });

  test("network error → 'network_error'", async () => {
    const r = await fetchUrl("http://127.0.0.1:1/never", { retries: 0, timeoutMs: 500 });
    expect(r.error === "network_error" || r.error === "timeout").toBe(true);
  });

  test("uses Firecrawl as the primary fetcher when configured", async () => {
    const previousKey = process.env.FIRECRAWL_API_KEY;
    const previousUrl = process.env.FIRECRAWL_API_URL;
    process.env.FIRECRAWL_API_KEY = "fc-test";
    process.env.FIRECRAWL_API_URL = baseUrl;
    firecrawlRequests = [];
    try {
      const r = await fetchUrl(`${baseUrl}/ok`, { retries: 0 });
      expect(r.error).toBeNull();
      expect(r.text).toBe("# Firecrawl article\n\nRecovered article text.");
      expect(r.byteLength).toBe(Buffer.byteLength(r.text, "utf8"));
      expect(r.contentSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(firecrawlRequests).toHaveLength(1);
      expect(firecrawlRequests[0]).toMatchObject({
        url: `${baseUrl}/ok`,
        formats: ["markdown"],
        onlyMainContent: true,
        proxy: "auto",
      });
    } finally {
      restoreEnv("FIRECRAWL_API_KEY", previousKey);
      restoreEnv("FIRECRAWL_API_URL", previousUrl);
    }
  });

  test("falls back to direct fetching when Firecrawl fails", async () => {
    const previousKey = process.env.FIRECRAWL_API_KEY;
    const previousUrl = process.env.FIRECRAWL_API_URL;
    process.env.FIRECRAWL_API_KEY = "fc-test";
    process.env.FIRECRAWL_API_URL = baseUrl;
    firecrawlRequests = [];
    try {
      const r = await fetchUrl(`${baseUrl}/firecrawl-fails`, { retries: 0 });
      expect(r.error).toBeNull();
      expect(r.text).toBe("direct fallback text");
      expect(r.byteLength).toBe(Buffer.byteLength(r.text, "utf8"));
      expect(firecrawlRequests).toHaveLength(1);
      expect(firecrawlRequests[0]).toMatchObject({
        url: `${baseUrl}/firecrawl-fails`,
        formats: ["markdown"],
        onlyMainContent: true,
        proxy: "auto",
      });
    } finally {
      restoreEnv("FIRECRAWL_API_KEY", previousKey);
      restoreEnv("FIRECRAWL_API_URL", previousUrl);
    }
  });
});

describe("hashText", () => {
  test("hashes utf-8 byte length", () => {
    const r = hashText("hello");
    expect(r.kind).toBe("text");
    expect(r.text).toBe("hello");
    expect(r.byteLength).toBe(5);
    expect(r.contentSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.error).toBeNull();
  });
  test("multi-byte chars", () => {
    const r = hashText("héllo");
    expect(r.byteLength).toBe(6); // 'h' + 'é'(2 bytes) + 'l' + 'l' + 'o'
  });
});

function restoreEnv(key: "FIRECRAWL_API_KEY" | "FIRECRAWL_API_URL", value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function extractRequestUrl(value: unknown): string {
  if (!isUnknownRecord(value)) return "";
  const url = value.url;
  return typeof url === "string" ? url : "";
}
