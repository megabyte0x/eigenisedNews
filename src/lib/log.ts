import type { UnknownRecord } from "./guards";

export type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, msg: string, fields?: UnknownRecord): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(fields ?? {}) });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}
