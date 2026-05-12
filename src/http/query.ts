import type { Request } from "express";

export function shouldIncludeRaw(req: Request): boolean {
  return req.query.include === "raw" || req.query.include === "raw=1";
}
