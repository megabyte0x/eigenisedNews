import { APICallError } from "ai";
import { buildCallErrorDebugInfo } from "../src/fanout/llmProxy";

const info = buildCallErrorDebugInfo(
  new APICallError({
    message: "Bad Request",
    url: "https://ai-gateway.eigencloud.xyz/v1/chat/completions",
    requestBodyValues: { prompt: "hi" },
    statusCode: 400,
    responseHeaders: { "x-request-id": "req_fixture_400" },
    responseBody: JSON.stringify({
      error: {
        message: "unsupported response_format",
        type: "invalid_request_error",
      },
    }),
    data: {
      error: {
        message: "unsupported response_format",
        type: "invalid_request_error",
      },
    },
  }),
  { provider: "openai", model: "gpt-4o" },
  "http_400"
);

if (info === null) {
  throw new Error("expected_debug_info");
}

console.log(JSON.stringify(info, null, 2));
