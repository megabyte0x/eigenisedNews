import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isUnknownRecord } from "../lib/guards";
import { sha256Hex } from "../lib/hash";
import { isNewsResearchResponse } from "../lib/manifestGuards";
import type {
  NewsResearchResponse,
  ResearchHistoryEntry,
  ResearchStorageInfo,
} from "../types";

export const EIGEN_PERSISTENT_DATA_PATH = "/mnt/disks/userdata";
export const EIGEN_PERSISTENT_STORAGE_DOCS_URL = "https://docs.eigencloud.xyz/eigencompute/howto/build/persistent_storage";

const STORE_SCHEMA_VERSION = "1";
const STORE_SUBDIRECTORY = "eigenised-news/research-reports";
const INDEX_FILE_NAME = "index.json";
let testStoreCounter = 0;

export type StoredResearchReport = {
  schemaVersion: typeof STORE_SCHEMA_VERSION;
  id: string;
  articleUrl: string;
  resolvedArticleUrl: string;
  normalizedArticleUrl: string;
  savedAt: string;
  updatedAt: string;
  response: NewsResearchResponse;
};

export type ResearchReportStore = {
  readonly info: ResearchStorageInfo;
  findByArticleUrl(articleUrl: string): Promise<StoredResearchReport | null>;
  get(id: string): Promise<StoredResearchReport | null>;
  list(): Promise<ResearchHistoryEntry[]>;
  save(response: NewsResearchResponse): Promise<StoredResearchReport>;
};

type StoreIndex = {
  schemaVersion: typeof STORE_SCHEMA_VERSION;
  entries: ResearchHistoryEntry[];
};

type StoragePathResolution = {
  reportsPath: string;
  persistentDataPath: string;
  source: ResearchStorageInfo["source"];
};

export function createResearchReportStore(env: NodeJS.ProcessEnv = process.env): ResearchReportStore {
  return new FileResearchReportStore(resolveResearchStoragePath(env));
}

export function resolveResearchStoragePath(env: NodeJS.ProcessEnv = process.env): StoragePathResolution {
  const explicitReportsPath = nonEmpty(env.RESEARCH_STORAGE_DIR);
  if (explicitReportsPath) {
    const resolved = resolve(explicitReportsPath);
    return {
      reportsPath: resolved,
      persistentDataPath: resolved,
      source: "research_storage_dir",
    };
  }

  const platformPersistentPath = nonEmpty(env.USER_PERSISTENT_DATA_PATH);
  if (platformPersistentPath) {
    const resolved = resolve(platformPersistentPath);
    return {
      reportsPath: join(resolved, STORE_SUBDIRECTORY),
      persistentDataPath: resolved,
      source: "user_persistent_data_path",
    };
  }

  if (env.NODE_ENV === "test" || env.VITEST === "true") {
    const testRoot = join(tmpdir(), "eigenised-news-vitest", `${process.pid}-${++testStoreCounter}`);
    return {
      reportsPath: join(testRoot, STORE_SUBDIRECTORY),
      persistentDataPath: testRoot,
      source: "local_dev",
    };
  }

  if (isEigenEnvironment(env.EIGEN_ENVIRONMENT)) {
    return {
      reportsPath: join(EIGEN_PERSISTENT_DATA_PATH, STORE_SUBDIRECTORY),
      persistentDataPath: EIGEN_PERSISTENT_DATA_PATH,
      source: "eigen_default",
    };
  }

  const localPath = resolve(".data", STORE_SUBDIRECTORY);
  return {
    reportsPath: localPath,
    persistentDataPath: resolve(".data"),
    source: "local_dev",
  };
}

export function researchReportIdForArticleUrl(articleUrl: string): string {
  return sha256Hex(normalizeArticleUrlForStorage(articleUrl)).slice("sha256:".length);
}

export function normalizeArticleUrlForStorage(articleUrl: string): string {
  const url = new URL(articleUrl.trim());
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  const sortedSearchParams = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    const keyOrder = leftKey.localeCompare(rightKey);
    return keyOrder === 0 ? leftValue.localeCompare(rightValue) : keyOrder;
  });
  url.search = "";
  for (const [key, value] of sortedSearchParams) url.searchParams.append(key, value);
  return url.toString();
}

export function clientResearchResponse(response: NewsResearchResponse, includeRaw: boolean): NewsResearchResponse {
  return {
    ...response,
    raw: includeRaw ? response.raw : null,
  };
}

class FileResearchReportStore implements ResearchReportStore {
  readonly info: ResearchStorageInfo;
  private readonly reportsPath: string;

  constructor(resolution: StoragePathResolution) {
    this.reportsPath = resolution.reportsPath;
    this.info = {
      reportsPath: resolution.reportsPath,
      persistentDataPath: resolution.persistentDataPath,
      source: resolution.source,
      docsUrl: EIGEN_PERSISTENT_STORAGE_DOCS_URL,
    };
  }

  async findByArticleUrl(articleUrl: string): Promise<StoredResearchReport | null> {
    return this.get(researchReportIdForArticleUrl(articleUrl));
  }

  async get(id: string): Promise<StoredResearchReport | null> {
    if (!isSafeReportId(id)) return null;
    try {
      const parsed = JSON.parse(await readFile(this.reportPath(id), "utf8")) as unknown;
      return isStoredResearchReport(parsed) ? parsed : null;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async list(): Promise<ResearchHistoryEntry[]> {
    await this.ensureDirectory();
    const index = await this.readIndex();
    if (index) return sortEntries(index.entries);

    const rebuilt = await this.rebuildIndex();
    return sortEntries(rebuilt.entries);
  }

  async save(response: NewsResearchResponse): Promise<StoredResearchReport> {
    await this.ensureDirectory();
    const articleUrl = response.manifest.request.articleUrl;
    const normalizedArticleUrl = normalizeArticleUrlForStorage(articleUrl);
    const id = researchReportIdForArticleUrl(articleUrl);
    const now = new Date().toISOString();
    const existing = await this.get(id);
    const record: StoredResearchReport = {
      schemaVersion: STORE_SCHEMA_VERSION,
      id,
      articleUrl,
      resolvedArticleUrl: response.article.url,
      normalizedArticleUrl,
      savedAt: existing?.savedAt ?? now,
      updatedAt: now,
      response,
    };

    await writeJsonAtomic(this.reportPath(id), record);
    await this.upsertIndex(buildHistoryEntry(record));
    return record;
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.reportsPath, { recursive: true });
  }

  private async readIndex(): Promise<StoreIndex | null> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath(), "utf8")) as unknown;
      return isStoreIndex(parsed) ? parsed : null;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  private async rebuildIndex(): Promise<StoreIndex> {
    const files = await readdir(this.reportsPath);
    const entries: ResearchHistoryEntry[] = [];
    for (const file of files) {
      if (!file.endsWith(".json") || file === INDEX_FILE_NAME) continue;
      const id = file.slice(0, -".json".length);
      const report = await this.get(id);
      if (report) entries.push(buildHistoryEntry(report));
    }
    const index: StoreIndex = { schemaVersion: STORE_SCHEMA_VERSION, entries: sortEntries(entries) };
    await writeJsonAtomic(this.indexPath(), index);
    return index;
  }

  private async upsertIndex(entry: ResearchHistoryEntry): Promise<void> {
    const index: StoreIndex = await this.readIndex() ?? { schemaVersion: STORE_SCHEMA_VERSION, entries: [] };
    const nextEntries = [entry, ...index.entries.filter((candidate) => candidate.id !== entry.id)];
    await writeJsonAtomic(this.indexPath(), {
      schemaVersion: STORE_SCHEMA_VERSION,
      entries: sortEntries(nextEntries),
    });
  }

  private reportPath(id: string): string {
    return join(this.reportsPath, `${id}.json`);
  }

  private indexPath(): string {
    return join(this.reportsPath, INDEX_FILE_NAME);
  }
}

function buildHistoryEntry(record: StoredResearchReport): ResearchHistoryEntry {
  const response = record.response;
  const articleUrl = record.articleUrl;
  return {
    id: record.id,
    articleUrl,
    resolvedArticleUrl: record.resolvedArticleUrl,
    normalizedArticleUrl: record.normalizedArticleUrl,
    articleHost: safeHost(articleUrl),
    manifestSha256: response.manifest.manifestSha256,
    articleContentSha256: response.article.contentSha256,
    fetchedAt: response.article.fetchedAt ?? null,
    researchedAt: response.manifest.timestamp,
    savedAt: record.savedAt,
    updatedAt: record.updatedAt,
    byteLength: response.article.byteLength,
    summaryPreview: preview(response.mainSummary),
  };
}

function sortEntries(entries: ResearchHistoryEntry[]): ResearchHistoryEntry[] {
  return [...entries].sort((left, right) => {
    const updatedOrder = right.updatedAt.localeCompare(left.updatedAt);
    return updatedOrder === 0 ? right.researchedAt.localeCompare(left.researchedAt) : updatedOrder;
  });
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function isStoredResearchReport(value: unknown): value is StoredResearchReport {
  return (
    isUnknownRecord(value) &&
    value.schemaVersion === STORE_SCHEMA_VERSION &&
    typeof value.id === "string" &&
    isSafeReportId(value.id) &&
    typeof value.articleUrl === "string" &&
    typeof value.resolvedArticleUrl === "string" &&
    typeof value.normalizedArticleUrl === "string" &&
    typeof value.savedAt === "string" &&
    typeof value.updatedAt === "string" &&
    isNewsResearchResponse(value.response)
  );
}

function isStoreIndex(value: unknown): value is StoreIndex {
  return (
    isUnknownRecord(value) &&
    value.schemaVersion === STORE_SCHEMA_VERSION &&
    Array.isArray(value.entries) &&
    value.entries.every(isResearchHistoryEntry)
  );
}

function isResearchHistoryEntry(value: unknown): value is ResearchHistoryEntry {
  return (
    isUnknownRecord(value) &&
    typeof value.id === "string" &&
    isSafeReportId(value.id) &&
    typeof value.articleUrl === "string" &&
    typeof value.resolvedArticleUrl === "string" &&
    typeof value.normalizedArticleUrl === "string" &&
    typeof value.articleHost === "string" &&
    typeof value.manifestSha256 === "string" &&
    (typeof value.articleContentSha256 === "string" || value.articleContentSha256 === null) &&
    (typeof value.fetchedAt === "string" || value.fetchedAt === null) &&
    typeof value.researchedAt === "string" &&
    typeof value.savedAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.byteLength === "number" &&
    typeof value.summaryPreview === "string"
  );
}

function isSafeReportId(id: string): boolean {
  return /^[0-9a-f]{64}$/i.test(id);
}

function isNotFoundError(error: unknown): boolean {
  return isUnknownRecord(error) && error.code === "ENOENT";
}

function isEigenEnvironment(value: string | undefined): boolean {
  return value === "mainnet-alpha" || value === "sepolia";
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "unknown host";
  }
}

function preview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 180)}…`;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
