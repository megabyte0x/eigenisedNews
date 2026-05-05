import { describe, expect, test } from "vitest";
import { resolveEigenGatewayUrl } from "../src/lib/eigenGateway";

describe("resolveEigenGatewayUrl", () => {
  test("prefers EIGEN_GATEWAY_URL when both env vars are present", () => {
    const url = resolveEigenGatewayUrl({
      EIGEN_GATEWAY_URL: "https://ai-gateway.eigencloud.xyz",
      EIGEN_GATEWAY_BASE_URL: "https://ai-gateway-dev.eigencloud.xyz",
    });
    expect(url).toBe("https://ai-gateway.eigencloud.xyz");
  });

  test("falls back to EIGEN_GATEWAY_BASE_URL for older local setups", () => {
    const url = resolveEigenGatewayUrl({
      EIGEN_GATEWAY_BASE_URL: "https://ai-gateway-dev.eigencloud.xyz",
    });
    expect(url).toBe("https://ai-gateway-dev.eigencloud.xyz");
  });

  test("uses the dev gateway default when no override is set", () => {
    expect(resolveEigenGatewayUrl({})).toBe("https://ai-gateway-dev.eigencloud.xyz");
  });
});
