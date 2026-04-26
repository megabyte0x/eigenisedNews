import type { Request, Response } from "express";
import { runSynthesis, type RunSynthesisDeps } from "../pipeline";
import type { SynthesizeRequest, SynthesizeResponse } from "../types";

export function makeSynthesizeHandler(deps: RunSynthesisDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = req.body as Partial<SynthesizeRequest> | undefined;
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "body_required" });
      return;
    }
    const request: SynthesizeRequest = {
      topic: typeof body.topic === "string" ? body.topic : "",
      urls: Array.isArray(body.urls) ? body.urls.filter((u) => typeof u === "string") : undefined,
      sources: Array.isArray(body.sources)
        ? body.sources.filter((s) => s && typeof s === "object" && typeof s.text === "string")
        : undefined,
    };
    if (request.urls === undefined) delete request.urls;
    if (request.sources === undefined) delete request.sources;

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
