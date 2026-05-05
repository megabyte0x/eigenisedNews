import type { Request, Response } from "express";
import { isUnknownRecord } from "../lib/guards";
import { runSynthesis, type RunSynthesisDeps } from "../pipeline";
import type { SynthesizeRequest, SynthesizeResponse } from "../types";

type SourceInput = NonNullable<SynthesizeRequest["sources"]>[number];

export function makeSynthesizeHandler(deps: RunSynthesisDeps) {
  return async (req: Request<Record<string, never>, unknown, unknown>, res: Response): Promise<void> => {
    const body = req.body;
    if (!isUnknownRecord(body)) {
      res.status(400).json({ error: "body_required" });
      return;
    }
    const request: SynthesizeRequest = {
      topic: typeof body.topic === "string" ? body.topic : "",
      ...(Array.isArray(body.urls) && { urls: body.urls.filter((u): u is string => typeof u === "string") }),
      ...(Array.isArray(body.sources) && {
        sources: body.sources.filter(isSourceInput),
      }),
    };

    const result = await runSynthesis(deps, request);

    if (result.status === "validation_error") {
      res.status(400).json({ error: result.error });
      return;
    }

    const includeRaw = req.query.include === "raw" || req.query.include === "raw=1";
    const response: SynthesizeResponse = {
      manifest: result.manifest,
      signature: result.signature,
      raw: includeRaw ? result.raw : null,
    };

    if (result.status === "threshold_not_met") {
      res.status(503).json({ error: "min_model_success_not_met", ...response });
      return;
    }
    res.status(200).json(response);
  };
}

function isSourceInput(value: unknown): value is SourceInput {
  if (!isUnknownRecord(value) || typeof value.text !== "string") return false;
  if ("title" in value && value.title !== undefined && typeof value.title !== "string") return false;
  if ("url" in value && value.url !== undefined && typeof value.url !== "string") return false;
  return true;
}
