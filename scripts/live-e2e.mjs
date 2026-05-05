import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_TOPIC = "Consensus extraction regression check";
const DEFAULT_SOURCE_TEXT =
  "On May 5, 2026, the eigenisedNews live E2E check submitted one source document and expected the system to return a signed manifest with consensus claims.";

export function buildLiveE2eRequest({ topic = DEFAULT_TOPIC, sourceText = DEFAULT_SOURCE_TEXT, sourceUrl = "", urls = [] } = {}) {
  const trimmedTopic = topic.trim();
  const trimmedSourceText = sourceText.trim();
  const trimmedSourceUrl = sourceUrl.trim();
  const normalizedUrls = urls.map((url) => url.trim()).filter(Boolean);
  const normalizedSources = trimmedSourceText ? [{ ...(trimmedSourceUrl ? { url: trimmedSourceUrl } : {}), text: trimmedSourceText }] : [];

  return {
    topic: trimmedTopic,
    ...(normalizedUrls.length > 0 ? { urls: normalizedUrls } : {}),
    ...(normalizedSources.length > 0 ? { sources: normalizedSources } : {}),
  };
}

export function buildSynthesizeUrl(appUrl) {
  const url = new URL("/synthesize?include=raw", normalizeAppUrl(appUrl));
  return url.toString();
}

export function assertLiveE2eResponse(response) {
  if (!response || typeof response !== "object") throw new Error("response_not_object");
  if (typeof response.signature !== "string" || !response.signature.startsWith("0x")) throw new Error("signature_missing");
  if (!response.manifest || typeof response.manifest !== "object") throw new Error("manifest_missing");
  if (!response.manifest.merge || typeof response.manifest.merge !== "object") throw new Error("merge_missing");
  if (response.manifest.merge.thresholdMet !== true) throw new Error("threshold_not_met");
  if (!Array.isArray(response.raw) || response.raw.length === 0) throw new Error("raw_outputs_missing");
  return {
    successfulModels: response.manifest.merge.successfulModels,
    totalModels: response.manifest.merge.totalModels,
    manifestSha256: response.manifest.manifestSha256,
  };
}

async function main() {
  const appUrl = process.env.APP_URL?.trim();
  if (!appUrl) throw new Error("APP_URL is required");

  const healthz = await fetch(new URL("/healthz", normalizeAppUrl(appUrl)));
  if (!healthz.ok) throw new Error(`healthz_failed_${healthz.status}`);

  const root = await fetch(new URL("/", normalizeAppUrl(appUrl)));
  const rootText = await root.text();
  if (!root.ok || !rootText.includes("eigenisedNews")) throw new Error(`frontend_shell_failed_${root.status}`);

  const request = buildLiveE2eRequest({
    topic: process.env.TOPIC ?? DEFAULT_TOPIC,
    sourceText: process.env.SOURCE_TEXT ?? DEFAULT_SOURCE_TEXT,
    sourceUrl: process.env.SOURCE_URL ?? "",
    urls: splitUrls(process.env.SOURCE_URLS ?? ""),
  });
  if (!request.topic || ((request.urls?.length ?? 0) + (request.sources?.length ?? 0) === 0)) {
    throw new Error("live_e2e_request_invalid");
  }

  const synthRes = await fetch(buildSynthesizeUrl(appUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const synthBody = await synthRes.json();
  if (!synthRes.ok) {
    throw new Error(`synthesize_failed_${synthRes.status}:${JSON.stringify(synthBody)}`);
  }

  const summary = assertLiveE2eResponse(synthBody);
  const outputPath = process.env.OUTPUT_PATH?.trim() || join(tmpdir(), "eigenised-news-live-e2e-response.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(synthBody, null, 2));

  console.log(JSON.stringify({ ok: true, appUrl, outputPath, ...summary }, null, 2));
}

function normalizeAppUrl(appUrl) {
  return appUrl.endsWith("/") ? appUrl : `${appUrl}/`;
}

function splitUrls(value) {
  return value
    .split("\n")
    .map((url) => url.trim())
    .filter(Boolean);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
