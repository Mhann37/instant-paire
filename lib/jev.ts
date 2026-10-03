import type { EnrichedWine } from "./types";
import { dishProfile } from "./enrich";

// System One-style judgments. If TYPESAFE_API_KEY is set, /api/rank calls the
// real Jev model (see jevRequest below). Otherwise this deterministic fallback
// produces the same shape so UI + confidence display never change.

export type Judgment = {
  pairingFit: number; // 0-2
  valueScore: number; // 0-1
  qualityScore: number; // 0-2
  confidence: number; // 0-1
  why: string;
  flags: string[];
};

export function judgeWine(w: EnrichedWine, dish: string): Judgment {
  const flags: string[] = [];
  const prof = dishProfile(dish);

  // Pairing: distance between wine profile and dish needs
  const tanninFit = 2 - Math.abs(w.tannin - prof.needsTannin);
  const acidFit = 2 - Math.abs(w.acidity - prof.needsAcid);
  const bodyFit = 2 - Math.abs(w.body - prof.needsBody);
  let pairingFit = Math.round(((tanninFit + acidFit + bodyFit) / 3) * 10) / 10;

  // Sparkling is the universal hedge; dessert wine with savoury is punished
  if (w.category === "sparkling") pairingFit = Math.min(2, pairingFit + 0.3);
  if (w.category === "dessert" && !/dessert|chocolate|cake|cheese/.test(dish.toLowerCase())) pairingFit = Math.max(0, pairingFit - 0.8);

  // Value: restaurant fair ≈ 2.5–3x retail. Without retail data, score on
  // relative cheapness within the list (cheapest third gets a lift).
  let valueScore = 0.55;
  if (w.listPrice && w.typicalRetailGBP) {
    const mult = w.listPrice / w.typicalRetailGBP;
    valueScore = mult <= 2.2 ? 0.95 : mult <= 3 ? 0.75 : mult <= 4 ? 0.5 : 0.3;
    if (mult > 4) flags.push("Steep markup vs typical retail");
  } else if (!w.listPrice) {
    valueScore = 0.5;
    flags.push("No price read — value unconfirmed");
  }
  if (!w.grounded) flags.push("Style inferred — verify vintage/producer");
  if (w.needsReview) flags.push("Check name spelling from photo");

  const qualityScore = w.qualityTier === "fine" ? 1.8 : w.qualityTier === "solid" ? 1.3 : w.qualityTier === "value" ? 1.0 : 1.0;

  // Confidence: OCR quality + groundedness + price presence
  let confidence = 0.72;
  confidence += w.grounded ? 0.12 : -0.08;
  confidence += w.listPrice ? 0.05 : -0.1;
  confidence += w.ocrConfidence >= 0.8 ? 0.05 : w.ocrConfidence < 0.6 ? -0.12 : 0;
  confidence = Math.max(0.3, Math.min(0.97, Math.round(confidence * 100) / 100));

  const why = buildWhy(w, dish, pairingFit, valueScore);
  return { pairingFit, valueScore, qualityScore, confidence, why, flags };
}

function buildWhy(w: EnrichedWine, dish: string, pairing: number, value: number): string {
  const dishShort = dish.length > 42 ? dish.slice(0, 42) + "…" : dish;
  if (pairing >= 1.5 && value >= 0.7) return `${cap(w.style)} loves ${dishShort} — acid/tannin line up and the price is fair for the list.`;
  if (pairing >= 1.5) return `${cap(w.style)} suits ${dishShort} well — price is the only question mark.`;
  if (value >= 0.75) return `Good value on this list, decent — not perfect — with ${dishShort}.`;
  return `Drinkable with ${dishShort}, but neither the pairing nor the price stands out.`;
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Shape of the real Jev call (kept here so swapping in is one env var).
// POST https://api.typesafe.ai/v1/systemone { state, questions }
// questions: pairing_fit (Score 0-2), value_fair (Noul), quality_tier (Score 0-2)
export function jevRequestBody(dish: string, wines: EnrichedWine[]) {
  return {
    model: "jev-latest",
    state: { dish, wines: wines.map((w) => ({ name: w.rawName, price: w.listPrice, style: w.style, category: w.category, body: w.body, acidity: w.acidity, tannin: w.tannin })) },
    questions: {
      pairing_fit: { type: "score", instructions: "How well does each wine's style suit `dish`? 0=clash, 1=ok, 2=ideal." },
      value_fair: { type: "noul", instructions: "Is the list price fair vs typical retail for this wine/style?" },
      quality_tier: { type: "score", instructions: "What quality tier is this wine? 0=simple, 1=solid, 2=fine." },
    },
  };
}
