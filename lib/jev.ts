import type { EnrichedWine } from "./types";
import { dishProfile } from "./enrich";

// Decisioning has two paths with identical output shape:
// 1. Real Jev via OpenRouter Decisions API (typesafe/jev-1.13, same OPENROUTER_API_KEY)
//    POST https://openrouter.ai/api/alpha/decisions { model, state, questions }
// 2. Deterministic heuristic fallback (offline, free) — UI never changes.

export const JEV_MODEL = process.env.JEV_MODEL ?? "typesafe/jev-1.13";

export type Judgment = {
  pairingFit: number; // 0-2
  valueScore: number; // 0-1
  qualityScore: number; // 0-2
  confidence: number; // 0-1 (Jev confidence when live, estimated otherwise)
  why: string;
  flags: string[];
  live: boolean;
};

export function judgeWine(w: EnrichedWine, dish: string): Judgment {
  const flags: string[] = [];
  const prof = dishProfile(dish);

  const tanninFit = 2 - Math.abs(w.tannin - prof.needsTannin);
  const acidFit = 2 - Math.abs(w.acidity - prof.needsAcid);
  const bodyFit = 2 - Math.abs(w.body - prof.needsBody);
  let pairingFit = Math.round(((tanninFit + acidFit + bodyFit) / 3) * 10) / 10;

  if (w.category === "sparkling") pairingFit = Math.min(2, pairingFit + 0.3);
  if (w.category === "dessert" && !/dessert|chocolate|cake|cheese/.test(dish.toLowerCase())) pairingFit = Math.max(0, pairingFit - 0.8);

  let valueScore = 0.55;
  if (w.listPrice && w.typicalRetailGBP) {
    const mult = w.listPrice / w.typicalRetailGBP;
    valueScore = mult <= 2.2 ? 0.95 : mult <= 3 ? 0.75 : mult <= 4 ? 0.5 : 0.3;
    if (mult > 4) flags.push("Steep markup vs typical retail");
  } else if (!w.listPrice) {
    valueScore = 0.5;
    flags.push("No price read - value unconfirmed");
  }
  if (!w.grounded) flags.push("Style inferred - verify vintage/producer");
  if (w.needsReview) flags.push("Check name spelling from photo");

  const qualityScore = w.qualityTier === "fine" ? 1.8 : w.qualityTier === "solid" ? 1.3 : w.qualityTier === "value" ? 1.0 : 1.0;

  let confidence = 0.72;
  confidence += w.grounded ? 0.12 : -0.08;
  confidence += w.listPrice ? 0.05 : -0.1;
  confidence += w.ocrConfidence >= 0.8 ? 0.05 : w.ocrConfidence < 0.6 ? -0.12 : 0;
  confidence = Math.max(0.3, Math.min(0.97, Math.round(confidence * 100) / 100));

  const why = buildWhy(w, dish, pairingFit, valueScore);
  return { pairingFit, valueScore, qualityScore, confidence, why, flags, live: false };
}

// --- Live Jev path (server-side only; called from /api/rank) ---

type JevAnswers = Record<string, { type: string; noul?: number; score?: number; confidence?: number }>;

export async function judgeWithJev(
  wines: EnrichedWine[],
  dish: string,
  apiKey: string,
  model = JEV_MODEL
): Promise<Map<string, { pairingFit: number; valueScore: number; confidence: number }>> {
  // Cap questions to keep the request fast: top 20 by list presence.
  const subset = wines.slice(0, 20);
  const questions: Record<string, unknown> = {};
  for (const w of subset) {
    const label = `${w.rawName}${w.vintage ? ` ${w.vintage}` : ""}${w.listPrice ? ` - £${w.listPrice}` : ""} (${w.style})`;
    questions[`pair_${w.id}`] = {
      type: "score",
      instructions: `How well does this wine suit the dish "${dish}"? Wine: ${label}.`,
      criteria: ["Clashes or wrong weight for the dish", "Decent match, nothing special", "Ideal pairing for the dish"],
    };
    questions[`value_${w.id}`] = {
      type: "noul",
      instructions: `Is this wine fair value at its list price? Wine: ${label}${w.typicalRetailGBP ? `, typical retail ~£${w.typicalRetailGBP}` : ""}. Restaurant fair is roughly 2.5-3x retail.`,
      criteria: { true: "Fair or good value at this list price", false: "Overpriced for what it is" },
    };
  }

  const res = await fetch("https://openrouter.ai/api/alpha/decisions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://instant-paire.vercel.app",
      "X-Title": "Instant Paire",
    },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({
      model,
      state: {
        dish,
        wines: subset.map((w) => ({
          id: w.id, name: w.rawName, vintage: w.vintage, listPrice: w.listPrice,
          style: w.style, category: w.category, body: w.body, acidity: w.acidity, tannin: w.tannin,
          typicalRetailGBP: w.typicalRetailGBP, qualityTier: w.qualityTier,
        })),
      },
      questions,
    }),
  });
  if (!res.ok) throw new Error(`Jev ${res.status}`);
  const data = await res.json();
  const answers = (data.answers ?? {}) as JevAnswers;
  const out = new Map<string, { pairingFit: number; valueScore: number; confidence: number }>();
  for (const w of subset) {
    const p = answers[`pair_${w.id}`];
    const v = answers[`value_${w.id}`];
    if (typeof p?.score !== "number" || typeof v?.noul !== "number") continue;
    const pairingFit = Math.max(0, Math.min(2, Math.round(p.score * 10) / 10));
    const valueScore = Math.max(0, Math.min(1, Math.round(v.noul * 100) / 100));
    const confidence = Math.max(0.3, Math.min(0.99,
      Math.round((((p.confidence ?? 0.7) + 0.7) / 2) * 100) / 100
    ));
    out.set(w.id, { pairingFit, valueScore, confidence });
  }
  if (!out.size) throw new Error("Jev returned no usable answers");
  return out;
}

function buildWhy(w: EnrichedWine, dish: string, pairing: number, value: number): string {
  const dishShort = dish.length > 42 ? dish.slice(0, 42) + "…" : dish;
  if (pairing >= 1.5 && value >= 0.7) return `${cap(w.style)} loves ${dishShort} - acid/tannin line up and the price is fair for the list.`;
  if (pairing >= 1.5) return `${cap(w.style)} suits ${dishShort} well - price is the only question mark.`;
  if (value >= 0.75) return `Good value on this list, decent - not perfect - with ${dishShort}.`;
  return `Drinkable with ${dishShort}, but neither the pairing nor the price stands out.`;
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
