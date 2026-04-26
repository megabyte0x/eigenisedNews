import { describe, test, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { callModel, parseStructuredOutput } from "../src/fanout/llmProxy";

let server: http.Server;
let baseUrl: string;
let mode: "ok" | "500-then-ok" | "500" | "404" | "hang" | "fenced" | "prose" | "bad-types" = "ok";
let hits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }
    hits++;
    if (mode === "hang") return;
    if (mode === "404") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    if (mode === "500" || (mode === "500-then-ok" && hits === 1)) {
      res.writeHead(500);
      res.end("upstream");
      return;
    }
    let content = '{"claims":[{"statement":"a","supportingSourceIndices":[0]}],"summary":"s"}';
    if (mode === "fenced") content = "```json\n" + content + "\n```";
    if (mode === "prose") content = "Sure! Here is the JSON:\n" + content;
    if (mode === "bad-types") content = '{"claims":[{"statement":"a","supportingSourceIndices":["zero"]}],"summary":"s"}';
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", model: "test", choices: [{ message: { role: "assistant", content } }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("callModel", () => {
  test("happy path returns rawOutput and latencyMs", async () => {
    mode = "ok"; hits = 0;
    const r = await callModel({
      proxyUrl: baseUrl, apiKey: "k",
      provider: "openai", model: "gpt-4o", version: "x",
      prompt: "hi", retries: 0, timeoutMs: 5000,
    });
    expect(r.rawOutput).toContain('"claims"');
    expect(typeof r.latencyMs).toBe("number");
  });

  test("500 once then 200 succeeds via retry", async () => {
    mode = "500-then-ok"; hits = 0;
    const r = await callModel({
      proxyUrl: baseUrl, apiKey: "k",
      provider: "openai", model: "gpt-4o", version: "x",
      prompt: "hi", retries: 1, timeoutMs: 5000,
    });
    expect(r.rawOutput).toContain('"claims"');
    expect(hits).toBe(2);
  });

  test("404 throws http_404 (no retry)", async () => {
    mode = "404"; hits = 0;
    await expect(
      callModel({ proxyUrl: baseUrl, apiKey: "k", provider: "openai", model: "gpt-4o", version: "x", prompt: "hi", retries: 1, timeoutMs: 5000 })
    ).rejects.toThrow(/http_404/);
    expect(hits).toBe(1);
  });

  test("timeout throws 'timeout'", async () => {
    mode = "hang"; hits = 0;
    await expect(
      callModel({ proxyUrl: baseUrl, apiKey: "k", provider: "openai", model: "gpt-4o", version: "x", prompt: "hi", retries: 0, timeoutMs: 200 })
    ).rejects.toThrow(/timeout/);
  });

  test("500 with retries=0 fails fast", async () => {
    mode = "500"; hits = 0;
    await expect(
      callModel({ proxyUrl: baseUrl, apiKey: "k", provider: "openai", model: "gpt-4o", version: "x", prompt: "hi", retries: 0, timeoutMs: 5000 })
    ).rejects.toThrow(/http_500/);
    expect(hits).toBe(1);
  });
});

describe("parseStructuredOutput", () => {
  test("parses well-formed JSON", () => {
    const out = parseStructuredOutput('{"claims":[{"statement":"a","supportingSourceIndices":[0,1]}],"summary":"s"}');
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0].statement).toBe("a");
    expect(out.claims[0].supportingSourceIndices).toEqual([0, 1]);
    expect(out.summary).toBe("s");
  });

  test("tolerates leading/trailing whitespace", () => {
    const out = parseStructuredOutput("  \n{\"claims\":[],\"summary\":\"\"}\n  ");
    expect(out.claims).toEqual([]);
  });

  test("rejects code-fenced output", () => {
    const fenced = "```json\n{\"claims\":[],\"summary\":\"\"}\n```";
    expect(() => parseStructuredOutput(fenced)).toThrow();
  });

  test("rejects extra prose", () => {
    expect(() => parseStructuredOutput('Sure!\n{"claims":[],"summary":""}')).toThrow();
  });

  test("rejects non-integer supportingSourceIndices", () => {
    expect(() =>
      parseStructuredOutput('{"claims":[{"statement":"a","supportingSourceIndices":["zero"]}],"summary":""}')
    ).toThrow();
  });

  test("rejects missing claims field", () => {
    expect(() => parseStructuredOutput('{"summary":""}')).toThrow();
  });

  test("rejects non-string statement", () => {
    expect(() => parseStructuredOutput('{"claims":[{"statement":42,"supportingSourceIndices":[]}],"summary":""}')).toThrow();
  });
});
