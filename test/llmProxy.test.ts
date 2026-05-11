import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as ai from "ai";
import { callModel, extractCallErrorDebugInfo, parseStructuredOutput, makeTestFactory } from "../src/fanout/llmProxy";
import { sha256Hex } from "../src/lib/hash";

const { aiMockState } = vi.hoisted(() => ({
  aiMockState: {
    actualGenerateText: undefined as typeof import("ai").generateText | undefined,
  },
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  aiMockState.actualGenerateText = actual.generateText;
  return {
    ...actual,
    generateText: vi.fn(actual.generateText),
  };
});

let server: http.Server;
let baseUrl: string;
let mode: "ok" | "500-then-ok" | "500" | "404" | "hang" | "fenced" | "prose" | "bad-types" = "ok";
let hits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (!req.url?.includes("/chat/completions") && !req.url?.includes("/v1/")) {
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
    res.end(JSON.stringify({ id: "x", model: "test", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  vi.mocked(ai.generateText).mockReset();
  vi.mocked(ai.generateText).mockImplementation(aiMockState.actualGenerateText ?? ai.generateText);
});

const factory = () => makeTestFactory({ baseURL: baseUrl });

describe("callModel", () => {
  test.each([
    ["openai", "gpt-4o"],
    ["google", "gemini-2.5-pro"],
    ["anthropic", "claude-sonnet-4.6"],
  ])("omits provider options for %s", async (provider, model) => {
    vi.mocked(ai.generateText).mockResolvedValue({ text: '{"claims":[],"summary":""}' } as Awaited<ReturnType<typeof ai.generateText>>);

    await callModel({
      provider,
      model,
      prompt: "hi",
      retries: 0,
      timeoutMs: 5000,
      modelFactory: factory(),
    });

    expect(ai.generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.anything(),
      prompt: "hi",
      temperature: expect.anything(),
      abortSignal: expect.anything(),
    }));
    expect(vi.mocked(ai.generateText).mock.calls.at(-1)?.[0]).not.toHaveProperty("providerOptions");
  });

  test("preserves GPT-4o upstream 400 detail for debug extraction without changing public error code", async () => {
    vi.mocked(ai.generateText).mockRejectedValue(new ai.APICallError({
      message: "Bad Request",
      url: "https://ai-gateway.eigencloud.xyz/v1/chat/completions",
      requestBodyValues: { prompt: "hi" },
      statusCode: 400,
      responseHeaders: { "x-request-id": "req_123" },
      responseBody: '{"error":{"message":"unsupported response_format","type":"invalid_request_error"}}',
      data: { error: { message: "unsupported response_format", type: "invalid_request_error" } },
    }));

    const error = await callModel({
      provider: "openai",
      model: "gpt-4o",
      prompt: "hi",
      retries: 0,
      timeoutMs: 5000,
      modelFactory: factory(),
    }).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "http_400" });
    expect(extractCallErrorDebugInfo(error)).toEqual({
      code: "http_400",
      provider: "openai",
      model: "gpt-4o",
      statusCode: 400,
      url: "https://ai-gateway.eigencloud.xyz/v1/chat/completions",
      responseHeaders: { "x-request-id": "req_123" },
      responseBody: '{"error":{"message":"unsupported response_format","type":"invalid_request_error"}}',
      data: { error: { message: "unsupported response_format", type: "invalid_request_error" } },
      message: "Bad Request",
    });
  });

  test("invokes onDebugInfo for GPT-4o upstream 400 detail", async () => {
    vi.mocked(ai.generateText).mockRejectedValue(new ai.APICallError({
      message: "Bad Request",
      url: "https://ai-gateway.eigencloud.xyz/v1/chat/completions",
      requestBodyValues: { prompt: "hi" },
      statusCode: 400,
      responseHeaders: { "x-request-id": "req_456" },
      responseBody: '{"error":{"message":"unsupported response_format","type":"invalid_request_error"}}',
      data: { error: { message: "unsupported response_format", type: "invalid_request_error" } },
    }));

    const onDebugInfo = vi.fn();

    await expect(callModel({
      provider: "openai",
      model: "gpt-4o",
      prompt: "hi",
      retries: 0,
      timeoutMs: 5000,
      modelFactory: factory(),
      onDebugInfo,
    })).rejects.toThrow("http_400");

    expect(onDebugInfo).toHaveBeenCalledWith({
      code: "http_400",
      provider: "openai",
      model: "gpt-4o",
      statusCode: 400,
      url: "https://ai-gateway.eigencloud.xyz/v1/chat/completions",
      responseHeaders: { "x-request-id": "req_456" },
      responseBody: '{"error":{"message":"unsupported response_format","type":"invalid_request_error"}}',
      data: { error: { message: "unsupported response_format", type: "invalid_request_error" } },
      message: "Bad Request",
    });
  });

  test("emits fallback debug info for GPT-4o http_400 when error is not APICallError", async () => {
    const fallbackError = Object.assign(new Error("Eigen Gateway API error (400): upstream rejected request"), {
      statusCode: 400,
      detail: { requestId: "req_fallback", provider: "openai" },
    });
    vi.mocked(ai.generateText).mockRejectedValue(fallbackError);

    const onDebugInfo = vi.fn();

    await expect(callModel({
      provider: "openai",
      model: "gpt-4o",
      prompt: "hi",
      retries: 0,
      timeoutMs: 5000,
      modelFactory: factory(),
      onDebugInfo,
    })).rejects.toThrow("http_400");

    expect(onDebugInfo).toHaveBeenCalledWith(expect.objectContaining({
      code: "http_400",
      provider: "openai",
      model: "gpt-4o",
      statusCode: 400,
      message: "Eigen Gateway API error (400): upstream rejected request",
      errorName: "Error",
      errorConstructor: "Error",
      errorFields: expect.objectContaining({
        detail: { requestId: "req_fallback", provider: "openai" },
        statusCode: 400,
      }),
    }));
  });

  test("classifies empty string model text as empty_response and preserves debug detail", async () => {
    vi.mocked(ai.generateText).mockResolvedValue({ text: "" } as Awaited<ReturnType<typeof ai.generateText>>);

    const error = await callModel({
      provider: "anthropic",
      model: "claude-opus-4.7",
      prompt: "hi",
      retries: 0,
      timeoutMs: 5000,
      modelFactory: factory(),
    }).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "empty_response" });
    expect(extractCallErrorDebugInfo(error)).toEqual({
      code: "empty_response",
      provider: "anthropic",
      model: "claude-opus-4.7",
      rawOutputSha256: sha256Hex(""),
      rawOutputByteLength: 0,
      rawOutput: "",
    });
  });

  test("uses an Opus-only structured-output fallback invocation when blank text has no recoverable payload", async () => {
    vi.mocked(ai.generateText)
      .mockResolvedValueOnce({ text: "   ", content: [], response: { body: { content: [] } }, steps: [] } as unknown as Awaited<ReturnType<typeof ai.generateText>>)
      .mockResolvedValueOnce({
        text: "",
        output: {
          claims: [{ statement: "fallback", supportingSourceIndices: [0] }],
          summary: "structured",
        },
      } as unknown as Awaited<ReturnType<typeof ai.generateText>>);

    const result = await callModel({
      provider: "anthropic",
      model: "claude-opus-4.7",
      prompt: "hi",
      retries: 0,
      timeoutMs: 5000,
      modelFactory: factory(),
    });

    expect(result.rawOutput).toBe('{"claims":[{"statement":"fallback","supportingSourceIndices":[0]}],"summary":"structured"}');
    expect(vi.mocked(ai.generateText)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ai.generateText).mock.calls[1]?.[0]).toMatchObject({
      prompt: "hi",
      providerOptions: {
        anthropic: {
          structuredOutputMode: "jsonTool",
        },
      },
      output: expect.anything(),
    });
  });

  test("keeps blank-text debug evidence when the Opus structured-output fallback also fails", async () => {
    vi.mocked(ai.generateText)
      .mockResolvedValueOnce({ text: "" } as Awaited<ReturnType<typeof ai.generateText>>)
      .mockRejectedValueOnce(new Error("structured fallback failed"));

    const error = await callModel({
      provider: "anthropic",
      model: "claude-opus-4.7",
      prompt: "hi",
      retries: 0,
      timeoutMs: 5000,
      modelFactory: factory(),
    }).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "empty_response" });
    expect(extractCallErrorDebugInfo(error)).toEqual({
      code: "empty_response",
      provider: "anthropic",
      model: "claude-opus-4.7",
      rawOutputSha256: sha256Hex(""),
      rawOutputByteLength: 0,
      rawOutput: "",
    });
  });

  test("recovers Opus payload from response.body when text is blank", async () => {
    vi.mocked(ai.generateText).mockResolvedValue(({
      text: "   ",
      content: [],
      response: {
        body: {
          content: [{ type: "text", text: '{"claims":[],"summary":"body"}' }],
        },
      },
      steps: [],
    }) as unknown as Awaited<ReturnType<typeof ai.generateText>>);

    const result = await callModel({
      provider: "anthropic",
      model: "claude-opus-4.7",
      prompt: "hi",
      retries: 0,
      timeoutMs: 5000,
      modelFactory: factory(),
    });

    expect(result.rawOutput).toBe('{"claims":[],"summary":"body"}');
  });

  test("recovers Opus payload from step-level response body when top-level text is blank", async () => {
    vi.mocked(ai.generateText).mockResolvedValue(({
      text: "\n",
      content: [],
      response: { body: { content: [] } },
      steps: [{
        text: "",
        content: [],
        response: {
          body: {
            message: {
              content: [{ type: "text", text: '{"claims":[],"summary":"step"}' }],
            },
          },
        },
      }],
    }) as unknown as Awaited<ReturnType<typeof ai.generateText>>);

    const result = await callModel({
      provider: "anthropic",
      model: "claude-opus-4.7",
      prompt: "hi",
      retries: 0,
      timeoutMs: 5000,
      modelFactory: factory(),
    });

    expect(result.rawOutput).toBe('{"claims":[],"summary":"step"}');
  });

  test("does not recover blank non-Opus text from response body", async () => {
    vi.mocked(ai.generateText).mockResolvedValue(({
      text: " ",
      content: [],
      response: {
        body: {
          content: [{ type: "text", text: '{"claims":[],"summary":"ignored"}' }],
        },
      },
      steps: [],
    }) as unknown as Awaited<ReturnType<typeof ai.generateText>>);

    const error = await callModel({
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      prompt: "hi",
      retries: 0,
      timeoutMs: 5000,
      modelFactory: factory(),
    }).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "empty_response" });
    expect(extractCallErrorDebugInfo(error)).toEqual({
      code: "empty_response",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      rawOutputSha256: sha256Hex(" "),
      rawOutputByteLength: Buffer.byteLength(" ", "utf8"),
      rawOutput: " ",
    });
  });

  test("retries empty_response and succeeds when a later attempt returns non-empty text", async () => {
    vi.mocked(ai.generateText)
      .mockResolvedValueOnce({ text: "   " } as Awaited<ReturnType<typeof ai.generateText>>)
      .mockRejectedValueOnce(new Error("structured fallback failed"))
      .mockResolvedValueOnce({ text: '{"claims":[],"summary":""}' } as Awaited<ReturnType<typeof ai.generateText>>);

    const onDebugInfo = vi.fn();
    const result = await callModel({
      provider: "anthropic",
      model: "claude-opus-4.7",
      prompt: "hi",
      retries: 1,
      timeoutMs: 5000,
      modelFactory: factory(),
      onDebugInfo,
    });

    expect(result.rawOutput).toBe('{"claims":[],"summary":""}');
    expect(vi.mocked(ai.generateText)).toHaveBeenCalledTimes(3);
    expect(onDebugInfo).toHaveBeenCalledWith({
      code: "empty_response",
      provider: "anthropic",
      model: "claude-opus-4.7",
      rawOutputSha256: sha256Hex("   "),
      rawOutputByteLength: Buffer.byteLength("   ", "utf8"),
      rawOutput: "   ",
    });
  });

  test("happy path returns rawOutput and latencyMs", async () => {
    mode = "ok";
    hits = 0;
    const r = await callModel({
      provider: "anthropic", model: "claude-sonnet-4.6",
      prompt: "hi", retries: 0, timeoutMs: 5000,
      modelFactory: factory(),
    });
    expect(r.rawOutput).toContain('"claims"');
    expect(typeof r.latencyMs).toBe("number");
  });

  test("500 once then 200 succeeds via retry", async () => {
    mode = "500-then-ok";
    hits = 0;
    const r = await callModel({
      provider: "anthropic", model: "claude-sonnet-4.6",
      prompt: "hi", retries: 1, timeoutMs: 5000,
      modelFactory: factory(),
    });
    expect(r.rawOutput).toContain('"claims"');
    expect(hits).toBe(2);
  });

  test("404 throws http_404 (no retry)", async () => {
    mode = "404";
    hits = 0;
    await expect(
      callModel({ provider: "anthropic", model: "claude-sonnet-4.6", prompt: "hi", retries: 1, timeoutMs: 5000, modelFactory: factory() })
    ).rejects.toThrow(/http_/);
    expect(hits).toBe(1);
  });

  test("timeout throws 'timeout'", async () => {
    mode = "hang";
    hits = 0;
    await expect(
      callModel({ provider: "anthropic", model: "claude-sonnet-4.6", prompt: "hi", retries: 0, timeoutMs: 200, modelFactory: factory() })
    ).rejects.toThrow(/timeout/);
  });

  test("500 with retries=0 fails fast", async () => {
    mode = "500";
    hits = 0;
    await expect(
      callModel({ provider: "anthropic", model: "claude-sonnet-4.6", prompt: "hi", retries: 0, timeoutMs: 5000, modelFactory: factory() })
    ).rejects.toThrow(/http_/);
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

  test("parses code-fenced output", () => {
    const fenced = "```json\n{\"claims\":[],\"summary\":\"\"}\n```";
    expect(parseStructuredOutput(fenced)).toEqual({ claims: [], summary: "" });
  });

  test("parses prose-wrapped code-fenced output", () => {
    const fenced = "Here is the JSON:\n```json\n{\"claims\":[],\"summary\":\"\"}\n```\nDone.";
    expect(parseStructuredOutput(fenced)).toEqual({ claims: [], summary: "" });
  });

  test("parses leading prose wrapped output", () => {
    expect(parseStructuredOutput('Sure!\n{"claims":[],"summary":""}')).toEqual({ claims: [], summary: "" });
  });

  test("parses single JSON object with trailing prose", () => {
    expect(parseStructuredOutput('{"claims":[],"summary":""}\nDone.')).toEqual({ claims: [], summary: "" });
  });

  test("rejects malformed wrapped output", () => {
    expect(() => parseStructuredOutput('Sure!\n{"claims":[],"summary":')).toThrow(/structured_output_not_pure_json/);
  });

  test("rejects ambiguous wrapped output", () => {
    expect(() =>
      parseStructuredOutput('Sure!\n{"claims":[],"summary":""}\n{"claims":[],"summary":"again"}')
    ).toThrow(/structured_output_not_pure_json/);
  });

  test("rejects multiple JSON fences", () => {
    expect(() =>
      parseStructuredOutput('```json\n{"claims":[],"summary":""}\n```\n```json\n{"claims":[],"summary":"again"}\n```')
    ).toThrow(/structured_output_not_pure_json/);
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
