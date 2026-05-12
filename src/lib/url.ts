export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function readUrlHost(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
