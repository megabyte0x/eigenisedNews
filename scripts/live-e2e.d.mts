export type LiveE2eRequest = {
  topic: string;
  urls?: string[];
  sources?: Array<{ url?: string; text: string }>;
};

export function buildLiveE2eRequest(args?: {
  topic?: string;
  sourceText?: string;
  sourceUrl?: string;
  urls?: string[];
}): LiveE2eRequest;

export function buildSynthesizeUrl(appUrl: string): string;

export function assertLiveE2eResponse(response: unknown): {
  successfulModels: number;
  totalModels: number;
  manifestSha256: string;
};
