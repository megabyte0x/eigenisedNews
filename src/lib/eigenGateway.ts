export const DEFAULT_EIGEN_GATEWAY_URL = "https://ai-gateway-dev.eigencloud.xyz";

export type EigenGatewayEnv = Partial<Record<"EIGEN_GATEWAY_URL" | "EIGEN_GATEWAY_BASE_URL", string | undefined>>;

export function resolveEigenGatewayUrl(env: EigenGatewayEnv = process.env): string {
  return trimOrNull(env.EIGEN_GATEWAY_URL) ?? trimOrNull(env.EIGEN_GATEWAY_BASE_URL) ?? DEFAULT_EIGEN_GATEWAY_URL;
}

function trimOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
