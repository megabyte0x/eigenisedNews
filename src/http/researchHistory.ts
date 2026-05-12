import type { Express, Response } from "express";
import { log } from "../lib/log";
import type { ResearchHistoryResponse } from "../types";
import { shouldIncludeRaw } from "./query";
import { clientResearchResponse, type ResearchReportStore } from "../storage/researchStore";

type ResearchHistoryErrorBody = {
  error: string;
  message: string;
};

export function mountResearchHistoryRoutes(app: Express, store: ResearchReportStore): void {
  app.get("/research/history", async (_req, res) => {
    try {
      const body: ResearchHistoryResponse = {
        entries: await store.list(),
        storage: store.info,
      };
      res.status(200).json(body);
    } catch (error) {
      log("warn", "research_history_unavailable", { error: error instanceof Error ? error.message : String(error) });
      sendHistoryError(res, 503, "research_history_unavailable", "Stored research history is not available from this runtime.");
    }
  });

  app.get("/research/history/:id", async (req, res) => {
    try {
      const report = await store.get(req.params.id);
      if (!report) {
        sendHistoryError(res, 404, "research_report_not_found", "No stored research report exists for that id.");
        return;
      }
      res.status(200).json(clientResearchResponse(report.response, shouldIncludeRaw(req)));
    } catch (error) {
      log("warn", "research_report_unavailable", {
        id: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      sendHistoryError(res, 503, "research_report_unavailable", "The stored research report could not be read.");
    }
  });
}

function sendHistoryError(
  res: Response,
  status: number,
  error: string,
  message: string,
): void {
  const body: ResearchHistoryErrorBody = { error, message };
  res.status(status).json(body);
}
