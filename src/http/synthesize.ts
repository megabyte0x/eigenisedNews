import type { Request, Response } from "express";
import { runSynthesis, type RunSynthesisDeps } from "../pipeline";
import type { SynthesizeRequest, SynthesizeResponse } from "../types";

export function makeSynthesizeHandler(deps: RunSynthesisDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = req.body as unknown;
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "body_required" });
      return;
    }
    const b = body as Record<string, unknown>;
    const request: SynthesizeRequest = {
      topic: typeof b.topic === "string" ? b.topic : "",
      ...(Array.isArray(b.urls) && { urls: b.urls.filter((u): u is string => typeof u === "string") }),
      ...(Array.isArray(b.sources) && {
        sources: (b.sources as unknown[]).filter(
          (s): s is { title?: string; url?: string; text: string } =>
            !!s && typeof s === "object" && typeof (s as Record<string, unknown>).text === "string"
        ),
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
