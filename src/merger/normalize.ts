export function normalizeClaim(s: string): string {
  let t = s.normalize("NFKC").toLowerCase();
  t = t.replace(/\s+/g, " ").trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    t = t.slice(1, -1).trim();
  }
  t = t.replace(/[.,;:!?]+$/g, "").trim();
  return t;
}
