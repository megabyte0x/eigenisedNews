import type { FrontendRuntimeConfig } from "./types";
import { isUnknownRecord } from "../lib/guards";
import { parseUnknownJson } from "../lib/json";

export function resolveFrontendApiUrl(endpoint: string, opts: { includeRaw?: boolean } = {}): string {
  const normalizedEndpoint = endpoint.replace(/^\/+/, "");
  const relativePath = buildRelativeApiPath(normalizedEndpoint, opts);
  const runtimeConfig = readFrontendRuntimeConfig();

  if (!runtimeConfig.apiBaseUrl?.trim()) return relativePath;

  const base = runtimeConfig.apiBaseUrl.trim().replace(/\/+$/, "") + "/";
  try {
    const url = new URL(normalizedEndpoint, base);
    if (opts.includeRaw) url.searchParams.set("include", "raw");
    return url.toString();
  } catch {
    return relativePath;
  }
}

function readFrontendRuntimeConfig(): FrontendRuntimeConfig {
  if (typeof document === "undefined") return {};

  const script = document.getElementById("frontend-runtime-config");
  if (!script?.textContent) return {};

  try {
    const parsed = parseUnknownJson(script.textContent);
    return isFrontendRuntimeConfig(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildRelativeApiPath(endpoint: string, opts: { includeRaw?: boolean }): string {
  return `/${endpoint}${opts.includeRaw ? "?include=raw" : ""}`;
}

function isFrontendRuntimeConfig(value: unknown): value is FrontendRuntimeConfig {
  return isUnknownRecord(value) && (!("apiBaseUrl" in value) || value.apiBaseUrl === undefined || typeof value.apiBaseUrl === "string");
}
