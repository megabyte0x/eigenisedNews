import type { SynthesizeRequest, SynthesizeResponse } from "../src/types";

export type LiveE2eRequest = SynthesizeRequest;

export function buildLiveE2eRequest(args?: {
  topic?: string;
  sourceText?: string;
  sourceUrl?: string;
  urls?: string[];
}): LiveE2eRequest;

export function buildSynthesizeUrl(appUrl: string): string;

export function assertLiveE2eResponse(response: unknown): {
  successfulModels: SynthesizeResponse["manifest"]["merge"]["successfulModels"];
  totalModels: SynthesizeResponse["manifest"]["merge"]["totalModels"];
  manifestSha256: SynthesizeResponse["manifest"]["manifestSha256"];
};
