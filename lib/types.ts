import type { CurrencyCode } from "./currency";

export type WineCandidate = {
  id: string;
  rawName: string;
  vintage?: string;
  listPrice?: number;
  region?: string; // as printed on the menu, e.g. "Barossa Valley"
  section?: string; // nearest grape/style heading, e.g. "Red - Shiraz"
  ocrConfidence: number; // 0-1
  needsReview: boolean;
};

export type EnrichedWine = WineCandidate & {
  style: string; // e.g. "oaky chardonnay", "tannic red"
  category: "red" | "white" | "rose" | "sparkling" | "dessert" | "unknown";
  body: number; // 0-2
  acidity: number; // 0-2
  tannin: number; // 0-2
  typicalRetailGBP?: number;
  qualityTier: "value" | "solid" | "fine" | "unknown";
  grounded: boolean; // true if from lookup/LLM with confidence, false if heuristic guess
};

// Crowd price index: what this bottle typically costs on restaurant lists (GBP-normalised).
export type MarketInfo = {
  n: number; // distinct menus seen
  medianGBP: number;
  minGBP: number;
  maxGBP: number;
};

export type RankedWine = EnrichedWine & {
  pairingFit: number; // 0-2 (Jev Score equivalent)
  valueScore: number; // 0-1 (Jev Noul equivalent)
  qualityScore: number; // 0-2
  finalScore: number; // 0-100
  confidence: number; // 0-1 calibrated display confidence
  confidenceBand: "High" | "Medium" | "Low";
  why: string;
  role?: "Best Match" | "Best Value" | "Wildcard";
  flags: string[];
  market?: MarketInfo & { deltaPct: number }; // deltaPct: this list's price vs the median (+ = dearer)
};

export type RankResponse = {
  ranked: RankedWine[];
  dish: string;
  meta: {
    enrichment: "llm" | "heuristic";
    decisioning: "jev" | "heuristic";
    warnings: string[];
    currency: CurrencyCode;
    marketMatches: number; // wines with enough price-index data to compare
    diagnostics?: string[]; // timings / model used / errors; shown in the UI only with ?debug
  };
};
