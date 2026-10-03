// Stable identity for a wine across scans/users: name + vintage, normalised. The per-scan ids
// ("w1", "w2"...) are NOT stable and must never be used as storage keys.

export function normalise(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function wineKey(rawName: string, vintage?: string): string {
  return `${normalise(rawName).slice(0, 80)}|${vintage ?? "nv"}`;
}
