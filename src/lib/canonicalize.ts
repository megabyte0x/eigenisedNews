const TEXT_ENCODER = new TextEncoder();

export function canonicalize(value: unknown): Uint8Array {
  return TEXT_ENCODER.encode(canonicalString(value));
}

function canonicalString(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalize: non-finite number");
    return Object.is(value, -0) ? "0" : value.toString();
  }
  if (typeof value === "string") return encodeString(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalString).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      parts.push(encodeString(k) + ":" + canonicalString(v));
    }
    return "{" + parts.join(",") + "}";
  }
  if (value === undefined) throw new Error("canonicalize: top-level undefined");
  throw new Error(`canonicalize: unsupported type ${typeof value}`);
}

function encodeString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}
