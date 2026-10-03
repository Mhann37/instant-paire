// Personal taste profile, kept on the device. Each "loved it / not for me" rating nudges a
// per-category affinity in [-1, 1] which /api/rank turns into a small score adjustment. This is
// what makes the 10th scan better than the 1st - a one-off chatbot chat starts from zero every time.

import type { EnrichedWine } from "./types";

const KEY = "ip_taste_v1";

export type Taste = { affinity: Partial<Record<EnrichedWine["category"], number>>; ratings: number };

export function getTaste(): Taste {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Taste | null;
    if (raw && typeof raw === "object" && raw.affinity) return { affinity: raw.affinity, ratings: Number(raw.ratings) || 0 };
  } catch {
    /* ignore */
  }
  return { affinity: {}, ratings: 0 };
}

export function recordRating(category: EnrichedWine["category"], rating: 1 | -1): Taste {
  const t = getTaste();
  if (category !== "unknown") {
    const prev = t.affinity[category] ?? 0;
    t.affinity[category] = Math.max(-1, Math.min(1, prev * 0.8 + 0.4 * rating));
  }
  t.ratings += 1;
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
  return t;
}
