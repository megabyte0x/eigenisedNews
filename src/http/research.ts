import type { Request, Response } from "express";
import { isUnknownRecord } from "../lib/guards";
import { runArticleResearch, type RunSynthesisDeps } from "../pipeline";
import type { NewsResearchRequest } from "../types";

export function makeResearchHandler(deps: RunSynthesisDeps) {
  return async (req: Request<Record<string, never>, unknown, unknown>, res: Response): Promise<void> => {
    const body = req.body;
    if (!isUnknownRecord(body)) {
      res.status(400).json({ error: "body_required" });
      return;
    }

    const request: NewsResearchRequest = {
      articleUrl: typeof body.articleUrl === "string" ? body.articleUrl : "",
    };

    try {
      const result = await runArticleResearch(deps, request);
      if (result.status === "validation_error") {
        res.status(400).json({ error: result.error });
        return;
      }
      if (result.status === "fetch_error") {
        res.status(502).json({ error: result.error, article: result.article });
        return;
      }

      const { status: _status, ...response } = result;
      res.status(200).json(response);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };
}
