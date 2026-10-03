import { after, NextRequest, NextResponse } from "next/server";
import type { EnrichedWine, RankResponse, RankedWine, WineCandidate } from "@/lib/types";
import { heuristicEnrich } from "@/lib/enrich";
import { judgeWine, judgeWithJev, JEV_MODEL } from "@/lib/jev";
import { parseCurrency, toGBP, type CurrencyCode } from "@/lib/currency";
import { FREE_SCANS_LIFETIME } from "@/lib/limits";
import { getDevice, rateLimit, setDeviceCookie } from "@/lib/guard";
import { getJsonMany, incr, peek, setJsonMany } from "@/lib/store";
import { wineKey } from "@/lib/wine-key";
import { lookupMarket, recordObservations } from "@/lib/market";

export const runtime = "nodejs";
export const maxDuration = 60;

const ENRICH_TTL_SEC = 60 * 60 * 24 * 30;
const CATEGORIES = ["red", "white", "rose", "sparkling", "dessert"] as const;

function fail(error: string, status: number) {
  return NextResponse.json({ error, ranked: [] }, { status });
}

export async function POST(req: NextRequest) {
  const device = getDevice(req);
  const res = await handle(req, device.id);
  if (device.isNew) setDeviceCookie(res, device.id);
  return res;
}

async function handle(req: NextRequest, deviceId: string): Promise<NextResponse> {
  const limited = (await rateLimit(req, "rank", 20, 600)) ?? (await rateLimit(req, "rank-day", 150, 86_400));
  if (limited) return limited;

  let body: { dish?: unknown; wines?: unknown; currency?: unknown; venue?: unknown; taste?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("Could not read the request. Try again.", 400);
  }

  const scanKey = `scans:${deviceId}`;
  if ((await peek(scanKey)) >= FREE_SCANS_LIFETIME) {
    return fail("Free scan limit reached on this device. Paid plans coming soon.", 402);
  }

  try {
    const dish: string = String(body.dish ?? "").slice(0, 200);
    const currency: CurrencyCode = parseCurrency(body.currency);
    const venue = typeof body.venue === "string" ? body.venue.trim().slice(0, 80) : "";
    const affinity = sanitiseAffinity(body.taste);

    const seenIds = new Set<string>();
    const wines: WineCandidate[] = (Array.isArray(body.wines) ? body.wines.slice(0, 40) : []).flatMap((raw, i) => {
      const w = (raw ?? {}) as Record<string, unknown>;
      const rawName = typeof w.rawName === "string" ? w.rawName.trim().slice(0, 120) : "";
      if (!rawName) return [];
      const price = Number(w.listPrice);
      const ocr = Number(w.ocrConfidence);
      // Ids must be unique: they key the Jev answers and the response.
      let id = typeof w.id === "string" && w.id ? w.id.slice(0, 40) : `w${i + 1}`;
      if (seenIds.has(id)) id = `w${i + 1}-${seenIds.size}`;
      seenIds.add(id);
      return [{
        id,
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

    // Price index: look up BEFORE recording so a list is never compared with its own prices.
    const market = await lookupMarket(enriched);

    // Value lift: cheapest third of priced wines gets a small bump when no retail data.
    const priced = enriched.filter((w) => w.listPrice).sort((a, b) => (a.listPrice ?? 0) - (b.listPrice ?? 0));
    const cheapSet = new Set(priced.slice(0, Math.ceil(priced.length / 3)).map((w) => w.id));

    // --- Decisioning: real Jev via OpenRouter when key present, else heuristic ---
    let decisioning: RankResponse["meta"]["decisioning"] = "heuristic";
    let jevScores = new Map<string, { pairingFit: number; valueScore: number; confidence: number }>();
    if (process.env.OPENROUTER_API_KEY) {
      try {
        jevScores = await judgeWithJev(enriched, dish, process.env.OPENROUTER_API_KEY, process.env.JEV_MODEL ?? JEV_MODEL, currency);
        decisioning = "jev";
      } catch (e) {
        console.error("Jev decisioning failed, using heuristic", e);
        warnings.push("Live sommelier judgments unavailable - used built-in scoring.");
      }
    }

    let marketMatches = 0;
    const ranked: RankedWine[] = enriched.map((w) => {
      const j = judgeWine(w, dish, currency);
      const live = jevScores.get(w.id);
      const pairingFit = live?.pairingFit ?? j.pairingFit;
      let valueScore = live?.valueScore ?? j.valueScore;
      // Blend Jev confidence with data-quality reality (OCR + groundedness)
      const confidence = live
        ? Math.max(0.3, Math.min(0.99, Math.round(((live.confidence * 0.7) + (j.confidence * 0.3)) * 100) / 100))
        : j.confidence;
      if (!w.grounded && cheapSet.has(w.id) && w.listPrice) valueScore = Math.min(0.9, valueScore + 0.12);

      const flags = live ? [...j.flags, "Judged live by Jev"] : [...j.flags];

      // Crowd price index: nudge value by how this list's price compares with the typical list price.
      let marketOut: RankedWine["market"];
      const m = market.get(wineKey(w.rawName, w.vintage));
      if (m && w.listPrice) {
        const deltaPct = Math.round((toGBP(w.listPrice, currency) / m.medianGBP - 1) * 100);
        marketOut = { ...m, deltaPct };
        marketMatches += 1;
        valueScore = Math.max(0, Math.min(1, valueScore + Math.max(-0.15, Math.min(0.15, (-deltaPct / 100) * 0.4))));
        if (Math.abs(deltaPct) >= 8) {
          flags.push(`${Math.abs(deltaPct)}% ${deltaPct < 0 ? "below" : "above"} typical list price (${m.n} menus)`);
        }
      }

      // Personal taste (from the user's own past ratings, held on their device).
      const aff = affinity[w.category as (typeof CATEGORIES)[number]] ?? 0;
      const tasteAdj = Math.round(aff * 4);
      if (aff >= 0.4) flags.push("Fits your taste");
      else if (aff <= -0.4) flags.push("Not usually your style");

      const base = (pairingFit / 2) * 50 + valueScore * 30 + (j.qualityScore / 2) * 20 + tasteAdj;
      const finalScore = Math.max(0, Math.min(100, Math.round(base)));
      // Cap confidence-displayed picks when OCR shaky or ungrounded
      const cappedFinal = w.ocrConfidence < 0.6 || !w.listPrice ? Math.min(finalScore, 69) : finalScore;
      const band = confidence >= 0.8 ? "High" : confidence >= 0.62 ? "Medium" : "Low";
      return { ...w, pairingFit, valueScore, qualityScore: j.qualityScore, finalScore: cappedFinal, confidence, confidenceBand: band, why: j.why, flags, market: marketOut };
    });

    ranked.sort((a, b) => b.finalScore - a.finalScore);

    // Assign roles: best overall, best value (cheaper + value>=0.6), wildcard (different category, pairing>=1.3)
    if (ranked[0]) ranked[0].role = "Best Match";
    const valuePick = ranked.find((w) => w.role !== "Best Match" && (w.listPrice ?? Infinity) <= (ranked[0]?.listPrice ?? Infinity) && w.valueScore >= 0.6);
    if (valuePick) valuePick.role = "Best Value";
    const wild = ranked.find((w) => !w.role && w.category !== ranked[0]?.category && w.pairingFit >= 1.2 && w.confidence >= 0.55);
    if (wild) wild.role = "Wildcard";

    // Successful scan: count it against the device quota, and feed the price index off the hot path.
    await incr(scanKey);
    after(() => recordObservations(wines, currency, venue));

    return NextResponse.json({ ranked, dish, meta: { enrichment, decisioning, warnings, currency, marketMatches } } satisfies RankResponse);
  } catch (e) {
    console.error("rank failed", e);
    return fail("Ranking failed - try again.", 500);
  }
}

function sanitiseAffinity(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const a = (raw as { affinity?: Record<string, unknown> } | null)?.affinity;
  if (!a || typeof a !== "object") return out;
  for (const c of CATEGORIES) {
    const n = Number(a[c]);
    if (Number.isFinite(n)) out[c] = Math.max(-1, Math.min(1, n));
  }
  return out;
}

async function llmEnrich(dish: string, wines: EnrichedWine[]): Promise<EnrichedWine[]> {
  const orKey = process.env.OPENROUTER_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const useOpenRouter = Boolean(orKey);
  const model = useOpenRouter
    ? (process.env.OPENROUTER_MODEL ?? process.env.OPENROUTER_OCR_MODEL ?? "stealth/space-bunny-alpha")
    : (process.env.OPENAI_MODEL ?? "gpt-4o-mini");

  // Shared cache (Redis when configured), keyed on the wine itself - ids are per-scan.
  const keys = wines.map((w) => `enr:${wineKey(w.rawName, w.vintage)}`);
  const cachedList = await getJsonMany<Partial<EnrichedWine>>(keys);
  const byKey = new Map<string, Partial<EnrichedWine>>();
  keys.forEach((k, i) => {
    const c = cachedList[i];
    if (c) byKey.set(k, c);
  });

  const uncached = wines.filter((_, i) => !byKey.has(keys[i]));
  if (uncached.length) {
    const idToKey = new Map(wines.map((w, i) => [w.id, keys[i]]));
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
    const fresh: [string, Partial<EnrichedWine>][] = [];
    for (const item of arr) {
      if (!item?.id) continue;
      const key = idToKey.get(item.id);
      if (!key) continue;
      const fields: Partial<EnrichedWine> = {
        style: String(item.style ?? "wine").slice(0, 60),
        category: validCat(item.category),
        body: num(item.body, 1), acidity: num(item.acidity, 1), tannin: num(item.tannin, 0),
        typicalRetailGBP: typeof item.typicalRetailGBP === "number" ? item.typicalRetailGBP : undefined,
        qualityTier: typeof item.qualityTier === "string" && ["value", "solid", "fine"].includes(item.qualityTier) ? (item.qualityTier as EnrichedWine["qualityTier"]) : "unknown",
        grounded: true,
      };
      byKey.set(key, fields);
      fresh.push([key, fields]);
    }
    await setJsonMany(fresh, ENRICH_TTL_SEC);
  }
  return wines.map((w, i) => ({ ...w, ...(byKey.get(keys[i]) ?? {}) }));
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
