import Firecrawl, { type Document as FirecrawlDocument } from "@mendable/firecrawl-js";
import { POLICY } from "../lib/policy";
import { sha256Hex, sha256OfBytes, type Sha256 } from "../lib/hash";

export type FetchUrlResult = {
  kind: "url";
  url: string;
  contentSha256: Sha256 | null;
  text: string;
  fetchedAt: string;
  byteLength: number;
  error: string | null;
};

type HashTextResult = {
  kind: "text";
  contentSha256: Sha256;
  text: string;
  byteLength: number;
  error: null;
};

export type FetchUrlOpts = {
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  userAgent?: string;
};

const TRANSIENT = new Set(["timeout", "network_error"]);
const FIRECRAWL_DEFAULT_API_URL = "https://api.firecrawl.dev";
const FIRECRAWL_TIMEOUT_MS = 30_000;

export async function fetchUrl(url: string, opts: FetchUrlOpts = {}): Promise<FetchUrlResult> {
  const timeoutMs = opts.timeoutMs ?? POLICY.FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? POLICY.FETCH_MAX_BYTES;
  const retries = opts.retries ?? POLICY.FETCH_RETRIES;
  const userAgent = opts.userAgent ?? POLICY.FETCH_USER_AGENT;

  const fetchedAt = new Date().toISOString();

  if (shouldAttemptFirecrawl(url)) {
    const firecrawlResult = await fetchUrlWithFirecrawl(url, fetchedAt, maxBytes);
    if (firecrawlResult) return firecrawlResult;
  }

  return fetchUrlDirect({ url, timeoutMs, maxBytes, retries, userAgent, fetchedAt });
}

type FetchUrlDirectArgs = {
  url: string;
  timeoutMs: number;
  maxBytes: number;
  retries: number;
  userAgent: string;
  fetchedAt: string;
};

async function fetchUrlDirect(args: FetchUrlDirectArgs): Promise<FetchUrlResult> {
  const { url, timeoutMs, maxBytes, retries, userAgent, fetchedAt } = args;
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": userAgent } });
      if (!res.ok) {
        lastError = `http_${res.status}`;
        await res.body?.cancel().catch(() => {});
        if (res.status >= 500 && attempt < retries) continue;
        return failed(url, fetchedAt, lastError);
      }
      const reader = res.body!.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let exceeded = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          exceeded = true;
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
      if (exceeded) return failed(url, fetchedAt, "byte_cap_exceeded");
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        buf.set(c, off);
        off += c.length;
      }
      const text = new TextDecoder().decode(buf);
      return { kind: "url", url, contentSha256: sha256OfBytes(buf), text, fetchedAt, byteLength: total, error: null };
    } catch (e) {
      lastError = e instanceof Error && e.name === "AbortError" ? "timeout" : "network_error";
      if (!TRANSIENT.has(lastError) || attempt >= retries) return failed(url, fetchedAt, lastError);
    } finally {
      clearTimeout(timer);
    }
  }
  return failed(url, fetchedAt, lastError ?? "network_error");
}

async function fetchUrlWithFirecrawl(url: string, fetchedAt: string, maxBytes: number): Promise<FetchUrlResult | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!apiKey) return null;

  const apiUrl = readFirecrawlApiUrl();
  try {
    const firecrawl = new Firecrawl({
      apiKey,
      apiUrl,
      timeoutMs: FIRECRAWL_TIMEOUT_MS + 5_000,
      maxRetries: 1,
    });
    const doc = await firecrawl.scrape(url, {
      formats: ["markdown"],
      onlyMainContent: true,
      timeout: FIRECRAWL_TIMEOUT_MS,
      proxy: "auto",
    });
    const text = extractFirecrawlText(doc);
    if (!text) return null;

    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > maxBytes) return null;

    return {
      kind: "url",
      url,
      contentSha256: sha256OfBytes(bytes),
      text,
      fetchedAt,
      byteLength: bytes.byteLength,
      error: null,
    };
  } catch {
    // Firecrawl is optional enrichment; direct bounded fetch remains the authoritative fallback.
    return null;
  }
}

function extractFirecrawlText(doc: FirecrawlDocument): string {
  return [doc.markdown, doc.html, doc.rawHtml, doc.summary]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim() ?? "";
}

function shouldAttemptFirecrawl(url: string): boolean {
  if (!process.env.FIRECRAWL_API_KEY?.trim()) return false;

  const apiUrl = readFirecrawlApiUrl();
  if (isPrivateOrLocalTarget(url) && !isPrivateOrLocalTarget(apiUrl)) return false;

  return true;
}

function readFirecrawlApiUrl(): string {
  return process.env.FIRECRAWL_API_URL?.trim() || FIRECRAWL_DEFAULT_API_URL;
}

function isPrivateOrLocalTarget(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
    if (host === "::1" || host === "[::1]") return true;
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    const parts = host.split(".").map((part) => Number.parseInt(part, 10));
    if (parts.length === 4 && parts.every((part) => Number.isInteger(part))) {
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      if (parts[0] === 169 && parts[1] === 254) return true;
    }
    return false;
  } catch {
    // Fail closed: malformed targets must not be sent to a remote Firecrawl API.
    return true;
  }
}

function failed(url: string, fetchedAt: string, error: string): FetchUrlResult {
  return { kind: "url", url, contentSha256: null, text: "", fetchedAt, byteLength: 0, error };
}

export function hashText(text: string): HashTextResult {
  return {
    kind: "text",
    contentSha256: sha256Hex(text),
    text,
    byteLength: Buffer.byteLength(text, "utf8"),
    error: null,
  };
}
