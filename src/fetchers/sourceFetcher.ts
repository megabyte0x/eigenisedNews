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

export async function fetchUrl(url: string, opts: FetchUrlOpts = {}): Promise<FetchUrlResult> {
  const timeoutMs = opts.timeoutMs ?? POLICY.FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? POLICY.FETCH_MAX_BYTES;
  const retries = opts.retries ?? POLICY.FETCH_RETRIES;
  const userAgent = opts.userAgent ?? POLICY.FETCH_USER_AGENT;

  const fetchedAt = new Date().toISOString();
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
