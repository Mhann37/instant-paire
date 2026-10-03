export type WineCandidate = {
  id: string;
  rawName: string;
  vintage?: string;
  listPrice?: number;
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
};

export type RankResponse = {
  ranked: RankedWine[];
  dish: string;
  meta: {
    enrichment: "llm" | "heuristic";
    decisioning: "jev" | "heuristic";
    warnings: string[];
  };
};
