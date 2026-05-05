import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function loadDotEnvFile(cwd = process.cwd()): boolean {
  const envPath = join(cwd, ".env");
  if (!existsSync(envPath)) return false;

  const contents = readFileSync(envPath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;

    const key = trimmed.slice(0, idx).trim();
    const rawValue = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = stripWrappingQuotes(rawValue);
    }
  }
  return true;
}

function stripWrappingQuotes(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
