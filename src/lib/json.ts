/**
 * JSON.parse is typed as `any` by TypeScript. Keep parsed JSON at the
 * external-boundary type until the caller narrows it with a runtime guard.
 */
export function parseUnknownJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
