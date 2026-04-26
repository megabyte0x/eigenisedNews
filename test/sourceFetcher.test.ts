import { describe, test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchUrl, hashText } from "../src/fetchers/sourceFetcher";

let server: http.Server;
let baseUrl: string;
let flakyHits = 0;

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
