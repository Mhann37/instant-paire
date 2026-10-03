import { NextRequest, NextResponse } from "next/server";
import type { EnrichedWine, RankResponse, RankedWine, WineCandidate } from "@/lib/types";
import { heuristicEnrich } from "@/lib/enrich";
import { judgeWine, judgeWithJev, JEV_MODEL } from "@/lib/jev";

export const runtime = "nodejs";
export const maxDuration = 60;

// In-memory cache for wine enrichment (per-instance; upgrade to Vercel KV later
// by swapping getCached/setCached with @vercel/kv — same key shape).
const cache = new Map<string, Partial<EnrichedWine>>();

function fail(error: string, status: number) {
  return NextResponse.json({ error, ranked: [] }, { status });
}

export async function POST(req: NextRequest) {
  let body: { dish?: unknown; wines?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("Could not read the request. Try again.", 400);
  }
  try {
    const dish: string = String(body.dish ?? "").slice(0, 200);
    const wines: WineCandidate[] = (Array.isArray(body.wines) ? body.wines.slice(0, 40) : []).flatMap((raw, i) => {
      const w = (raw ?? {}) as Record<string, unknown>;
      const rawName = typeof w.rawName === "string" ? w.rawName.trim().slice(0, 120) : "";
      if (!rawName) return [];
      const price = Number(w.listPrice);
      const ocr = Number(w.ocrConfidence);
      return [{
        id: typeof w.id === "string" && w.id ? w.id.slice(0, 40) : `w${i + 1}`,
        rawName,
        vintage: typeof w.vintage === "string" && /^(19|20)\d{2}$/.test(w.vintage) ? w.vintage : undefined,
        listPrice: Number.isFinite(price) && price > 0 ? price : undefined,
        ocrConfidence: Number.isFinite(ocr) ? Math.max(0, Math.min(1, ocr)) : 0.7,
        needsReview: w.needsReview === true,
      }];
    });
    if (!dish.trim()) return fail("Tell us what you're eating first.", 400);
    if (!wines.length) return fail("No wines to rank - rescan the list.", 400);

    let enriched = heuristicEnrich(wines);
    let enrichment: RankResponse["meta"]["enrichment"] = "heuristic";
    const warnings: string[] = [];

    // Upgrade with LLM when key present (single batched call, via OpenRouter).
    if (process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY) {
      try {
        enriched = await llmEnrich(dish, enriched);
        enrichment = "llm";
      } catch {
        warnings.push("Live wine lookup failed — used on-device estimates instead.");
      }
    } else {
      warnings.push("Running on built-in wine knowledge — add OPENROUTER_API_KEY for live retail + quality data.");
    }

    // Value lift: cheapest third of priced wines gets a small bump when no retail data.
    const priced = enriched.filter((w) => w.listPrice).sort((a, b) => (a.listPrice ?? 0) - (b.listPrice ?? 0));
    const cheapSet = new Set(priced.slice(0, Math.ceil(priced.length / 3)).map((w) => w.id));

    // --- Decisioning: real Jev via OpenRouter when key present, else heuristic ---
    let decisioning: RankResponse["meta"]["decisioning"] = "heuristic";
    let jevScores = new Map<string, { pairingFit: number; valueScore: number; confidence: number }>();
    if (process.env.OPENROUTER_API_KEY) {
      try {
        jevScores = await judgeWithJev(enriched, dish, process.env.OPENROUTER_API_KEY, process.env.JEV_MODEL ?? JEV_MODEL);
        decisioning = "jev";
      } catch (e) {
        console.error("Jev decisioning failed, using heuristic", e);
        warnings.push("Live sommelier judgments unavailable - used built-in scoring.");
      }
    }

    const ranked: RankedWine[] = enriched.map((w) => {
      const j = judgeWine(w, dish);
      const live = jevScores.get(w.id);
      const pairingFit = live?.pairingFit ?? j.pairingFit;
      let valueScore = live?.valueScore ?? j.valueScore;
      // Blend Jev confidence with data-quality reality (OCR + groundedness)
      const confidence = live
        ? Math.max(0.3, Math.min(0.99, Math.round(((live.confidence * 0.7) + (j.confidence * 0.3)) * 100) / 100))
        : j.confidence;
      if (!w.grounded && cheapSet.has(w.id) && w.listPrice) valueScore = Math.min(0.9, valueScore + 0.12);
      const finalScore = Math.round((pairingFit / 2) * 50 + valueScore * 30 + (j.qualityScore / 2) * 20);
      // Cap confidence-displayed picks when OCR shaky or ungrounded
      const cappedFinal = w.ocrConfidence < 0.6 || !w.listPrice ? Math.min(finalScore, 69) : finalScore;
      const band = confidence >= 0.8 ? "High" : confidence >= 0.62 ? "Medium" : "Low";
      const flags = live ? [...j.flags, "Judged live by Jev"] : j.flags;
      return { ...w, pairingFit, valueScore, qualityScore: j.qualityScore, finalScore: cappedFinal, confidence, confidenceBand: band, why: j.why, flags };
    });

    ranked.sort((a, b) => b.finalScore - a.finalScore);

    // Assign roles: best overall, best value (cheaper + value>=0.6), wildcard (different category, pairing>=1.3)
    if (ranked[0]) ranked[0].role = "Best Match";
    const valuePick = ranked.find((w) => w.role !== "Best Match" && (w.listPrice ?? Infinity) <= (ranked[0]?.listPrice ?? Infinity) && w.valueScore >= 0.6);
    if (valuePick) valuePick.role = "Best Value";
    const wild = ranked.find((w) => !w.role && w.category !== ranked[0]?.category && w.pairingFit >= 1.2 && w.confidence >= 0.55);
    if (wild) wild.role = "Wildcard";

    return NextResponse.json({ ranked, dish, meta: { enrichment, decisioning, warnings } } satisfies RankResponse);
  } catch (e) {
    console.error("rank failed", e);
    return fail("Ranking failed - try again.", 500);
  }
}

async function llmEnrich(dish: string, wines: EnrichedWine[]): Promise<EnrichedWine[]> {
  const orKey = process.env.OPENROUTER_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const useOpenRouter = Boolean(orKey);
  const model = useOpenRouter
    ? (process.env.OPENROUTER_MODEL ?? process.env.OPENROUTER_OCR_MODEL ?? "stealth/space-bunny-alpha")
    : (process.env.OPENAI_MODEL ?? "gpt-4o-mini");
  const uncached = wines.filter((w) => !cache.has(cacheKey(w)));
  const byId = new Map(wines.map((w) => [w.id, w]));
  if (uncached.length) {
    const prompt = `You are a sommelier data API. For each wine below, return JSON array with: {id, style (short), category (red|white|rose|sparkling|dessert|unknown), body (0-2), acidity (0-2), tannin (0-2), typicalRetailGBP (number or null, UK high-street price), qualityTier (value|solid|fine|unknown)}.\nWines: ${JSON.stringify(uncached.map((w) => ({ id: w.id, name: w.rawName, vintage: w.vintage, listPrice: w.listPrice })))}`;
    const endpoint = useOpenRouter ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.openai.com/v1/chat/completions";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${useOpenRouter ? orKey! : openaiKey!}`,
      "Content-Type": "application/json",
      ...(useOpenRouter ? { "HTTP-Referer": "https://instant-paire.vercel.app", "X-Title": "Instant Paire" } : {}),
    };
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Return only JSON: {wines: [...]}. Never invent vintages. Use null when unsure." },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}`);
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}") as { wines?: LlmWineItem[] };
    const arr: LlmWineItem[] = parsed.wines ?? [];
    for (const item of arr) {
      if (!item?.id) continue;
      const src = byId.get(item.id);
      if (!src) continue;
      cache.set(cacheKey(src), {
        style: String(item.style ?? "wine").slice(0, 60),
        category: validCat(item.category),
        body: num(item.body, 1), acidity: num(item.acidity, 1), tannin: num(item.tannin, 0),
        typicalRetailGBP: typeof item.typicalRetailGBP === "number" ? item.typicalRetailGBP : undefined,
        qualityTier: typeof item.qualityTier === "string" && ["value", "solid", "fine"].includes(item.qualityTier) ? (item.qualityTier as EnrichedWine["qualityTier"]) : "unknown",
        grounded: true,
      });
    }
  }
  return wines.map((w) => ({ ...w, ...(cache.get(cacheKey(w)) ?? {}) }));
}

// Ids ("w1", "w2"...) are per-scan, so the cache must key on the wine itself.
function cacheKey(w: EnrichedWine) {
  return `wine:${w.rawName.toLowerCase().replace(/\s+/g, " ").trim()}|${w.vintage ?? ""}`;
}

type LlmWineItem = {
  id: string;
  style?: unknown;
  category?: unknown;
  body?: unknown;
  acidity?: unknown;
  tannin?: unknown;
  typicalRetailGBP?: unknown;
  qualityTier?: unknown;
};
function validCat(c: unknown): EnrichedWine["category"] {
  return ["red", "white", "rose", "sparkling", "dessert"].includes(c as string) ? (c as EnrichedWine["category"]) : "unknown";
}
function num(v: unknown, fb: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : fb;
}
