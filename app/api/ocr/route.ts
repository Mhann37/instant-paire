import { NextRequest, NextResponse } from "next/server";
import type { WineCandidate } from "@/lib/types";
import { parseCurrency, type CurrencyCode } from "@/lib/currency";
import { FREE_SCANS_LIFETIME } from "@/lib/limits";
import { getDevice, rateLimit, setDeviceCookie } from "@/lib/guard";
import { peek } from "@/lib/store";
import { LlmHttpError, openrouterChat } from "@/lib/openrouter";

export const runtime = "nodejs";
export const maxDuration = 60;

// Speed notes: reading a menu is perception, not reasoning. We use a small fast vision model
// with reasoning OFF, a hard token cap, and a compact line format (name|vintage|price) instead of
// verbose JSON so there are far fewer output tokens to generate. If the primary model errors or
// finds nothing, one retry goes to a stronger fallback model.
const PRIMARY_MODEL = process.env.OCR_MODEL ?? "inclusionai/ling-3.0-flash-vl";
const FALLBACK_MODEL = process.env.OCR_FALLBACK_MODEL ?? "google/gemini-3.8-flash";
const PRIMARY_TIMEOUT_MS = 22_000;
const FALLBACK_TIMEOUT_MS = 28_000;
// Vercel serverless request body limit is ~4.5MB; base64 inflates by ~1.33x.
const MAX_TOTAL_CHARS = 4_100_000;
const MAX_TILES = 6;
const MAX_WINES = 60;

const SYSTEM_PROMPT = [
  "You are a precise wine-list OCR engine. Reply with plain text only - no commentary, no markdown.",
  "Line 1: CURRENCY=<ISO code of the menu prices: GBP, EUR, USD, AUD, CAD or CHF; GBP if unsure>.",
  `Then one wine per line with exactly 5 fields separated by | (max ${MAX_WINES} lines):`,
  "section|name|region|vintage|prices",
  "section = the nearest heading ABOVE the wine that names its grape or style (e.g. SHIRAZ, RIESLING, PROSECCO, CHAMPAGNE). If a colour heading also applies write it first, e.g. \"Red - Shiraz\". Leave empty only if no heading is visible.",
  "name = the producer / wine name as printed - not the grape heading, region or tasting notes.",
  "region = the region or country printed on the row, else empty.",
  "vintage = 4-digit year, or empty.",
  "prices = EVERY price printed on that row as plain numbers separated by / (e.g. 8/12/30 for small glass / large glass / bottle). Empty if none.",
  "Skip headings, column titles, food and anything that is not a wine. Include every wine. Never invent wines or prices.",
].join("\n");

class OcrError extends Error {
  constructor(message: string, readonly status: number, readonly retryable = true) {
    super(message);
  }
}

type Parsed = { wines: WineCandidate[]; currency: CurrencyCode };

function fail(error: string, status: number) {
  return NextResponse.json({ error, wines: [] }, { status });
}

export async function POST(req: NextRequest) {
  const device = getDevice(req);
  const res = await handle(req, device.id);
  if (device.isNew) setDeviceCookie(res, device.id);
  return res;
}

async function handle(req: NextRequest, deviceId: string): Promise<NextResponse> {
  const limited = (await rateLimit(req, "ocr", 12, 600)) ?? (await rateLimit(req, "ocr-day", 150, 86_400));
  if (limited) return limited;
  // Don't spend OCR credit on devices that have used their free scans.
  if ((await peek(`scans:${deviceId}`)) >= FREE_SCANS_LIFETIME) return fail("Free scan limit reached on this device. Paid plans coming soon.", 402);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return fail("Photo reading isn't configured yet. Add OPENROUTER_API_KEY in Vercel, or add wines manually below.", 501);
  }

  let body: { image?: unknown; images?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("Could not read the upload. Try a smaller photo.", 400);
  }

  const images = (Array.isArray(body.images) ? body.images : typeof body.image === "string" ? [body.image] : []).filter((i): i is string => typeof i === "string");
  if (!images.length || images.length > MAX_TILES || images.some((i) => !i.startsWith("data:image/"))) return fail("Send the photo as an image data URL.", 400);
  if (images.reduce((n, i) => n + i.length, 0) > MAX_TOTAL_CHARS) return fail("Photo too large - take a closer shot of just the wine list.", 413);

  const started = Date.now();
  // Tall screenshots arrive as overlapping slices so the text stays legible; read them in parallel.
  const results = await Promise.allSettled(images.map((img, i) => readTile(img, apiKey, images.length > 1 ? `Slice ${i + 1} of ${images.length} of a longer menu (neighbouring slices overlap). If the heading for the first rows is cut off, leave section empty.` : "", images.length === 1)));

  const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failed = results.length - ok.length;
  const wines = mergeTiles(ok.map((r) => r.wines));
  const model = ok[0]?.model ?? PRIMARY_MODEL;
  console.info("ocr done", JSON.stringify({ tiles: images.length, failedTiles: failed, wines: wines.length, ms: Date.now() - started, models: ok.map((r) => r.model) }));

  if (!wines.length) {
    const firstErr = results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;
    const err = firstErr instanceof OcrError ? firstErr : new OcrError("No wines found in the photo.", 422);
    return fail(err.message, err.status);
  }
  const currency = ok.map((r) => r.currency).find(Boolean) ?? "GBP";
  return NextResponse.json({ wines, currency, model, ms: Date.now() - started, partial: failed > 0 });
}

/** One slice: primary model, then one retry on the fallback if it errors (or, for single images, finds nothing). */
async function readTile(image: string, apiKey: string, note: string, retryOnEmpty: boolean): Promise<Parsed & { model: string }> {
  // Models with mandatory reasoning (e.g. Gemini Flash) spend part of max_tokens on thinking, hence the bigger cap.
  const attempts: [string, number, number][] = [[PRIMARY_MODEL, PRIMARY_TIMEOUT_MS, 2800]];
  if (FALLBACK_MODEL && FALLBACK_MODEL !== PRIMARY_MODEL) attempts.push([FALLBACK_MODEL, FALLBACK_TIMEOUT_MS, 8000]);

  let lastErr: OcrError | null = null;
  for (const [model, timeoutMs, maxTokens] of attempts) {
    try {
      const parsed = await readMenu(model, image, apiKey, timeoutMs, maxTokens, note);
      if (!parsed.wines.length && retryOnEmpty) throw new OcrError("No wines found in the photo.", 422);
      return { ...parsed, model };
    } catch (e) {
      lastErr = e instanceof OcrError ? e : new OcrError("List reading failed. Try again or add wines manually.", 500);
      console.error("ocr attempt failed", JSON.stringify({ model, status: lastErr.status, msg: lastErr.message }));
      if (!lastErr.retryable) break;
    }
  }
  throw lastErr ?? new OcrError("List reading failed. Try again or add wines manually.", 500);
}

/** Concatenate slices in reading order, carry headings across slice boundaries, name wines, drop overlap duplicates. */
function mergeTiles(tiles: WineCandidate[][]): WineCandidate[] {
  const out: WineCandidate[] = [];
  const seen = new Set<string>();
  let lastSection = "";
  for (const w of tiles.flat()) {
    if (w.section) lastSection = w.section;
    else if (lastSection) w.section = lastSection;
    // Menus often print only the producer; the grape lives in the heading. Put it back so the wine is identifiable.
    const variety = w.section ? varietyOf(w.section) : "";
    const rawName = (variety && !w.rawName.toLowerCase().includes(variety.toLowerCase()) ? `${w.rawName} ${variety}` : w.rawName).slice(0, 120);
    const key = `${rawName.toLowerCase().replace(/[^a-z0-9]/g, "")}|${w.region?.toLowerCase() ?? ""}|${w.listPrice ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...w, rawName, id: `w${out.length + 1}` });
    if (out.length >= MAX_WINES) break;
  }
  return out;
}

async function readMenu(model: string, image: string, apiKey: string, timeoutMs: number, maxTokens: number, note: string): Promise<Parsed> {
  let data;
  try {
    ({ data } = await openrouterChat(
      apiKey,
      {
        model,
        temperature: 0,
        max_tokens: maxTokens,
        provider: { sort: "latency" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: `Transcribe every wine on this list. ${note}`.trim() },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
      },
      timeoutMs,
    ));
  } catch (e) {
    if (e instanceof LlmHttpError) {
      console.error("OpenRouter OCR failed", model, e.status, e.body.slice(0, 500));
      if (e.status === 401 || e.status === 403) throw new OcrError("OpenRouter key was rejected. Check OPENROUTER_API_KEY in Vercel.", 502, false);
      if (e.status === 429) throw new OcrError("Rate limited by the model provider - try again in a moment.", 429);
      if (e.status === 404 || /no endpoints|model not found/i.test(e.body)) throw new OcrError(`Model "${model}" is unavailable on OpenRouter. Set OCR_MODEL to a vision model.`, 502);
      throw new OcrError("List reading failed upstream. Try again, or add wines manually.", 502);
    }
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new OcrError(timedOut ? "Reading timed out. Try a tighter photo of the list." : "List reading failed. Try again or add wines manually.", timedOut ? 504 : 502);
  }

  const content: string = data?.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) {
    // Typically means the model burned the token cap thinking, or the provider ignored reasoning:off.
    console.error("OCR empty content", model, JSON.stringify(data?.usage ?? {}), data?.choices?.[0]?.finish_reason);
    throw new OcrError("Model returned an empty reading. Try again or add wines manually.", 502);
  }
  return parseMenu(content);
}

// ---- parsing ----

function toPrice(raw: unknown): number | undefined {
  // "8/12/30" or "£22 glass / £110" -> the bottle is the biggest figure.
  const nums = (String(raw ?? "").replace(/,(?=\d{3}\b)/g, "").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const n = nums.length ? Math.max(...nums) : NaN;
  return Number.isFinite(n) && n >= 5 && n <= 5000 ? n : undefined;
}

function toVintage(raw: unknown): string | undefined {
  const m = String(raw ?? "").match(/\b(19\d{2}|20[0-2]\d)\b/);
  return m ? m[1] : undefined;
}

const COLOURS = /^(red|white|ros[eé]|sparkling|dessert|fortified)$/i;

/** "Red - Shiraz" -> "Shiraz"; "GSM" stays "GSM"; "RIESLING" -> "Riesling". */
function varietyOf(section: string): string {
  const parts = section.split(/\s*(?:[-–—>/,:]|\bwine\b)\s*/i).map((p) => p.trim()).filter(Boolean);
  const v = [...parts].reverse().find((p) => !COLOURS.test(p)) ?? parts[parts.length - 1] ?? "";
  if (v.length <= 4 && v === v.toUpperCase()) return v;
  return v.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

type Row = { section: string; name: string; region: string; vintage?: string; price?: number };

function parseMenu(content: string): Parsed {
  const text = content.replace(/```[a-z]*\n?/gi, "").trim();
  let currency: CurrencyCode = "GBP";
  const rows: Row[] = [];

  if (text.startsWith("{")) {
    // A fallback model ignoring the line format and answering with JSON.
    try {
      const j = JSON.parse(text) as { currency?: unknown; wines?: { section?: unknown; name?: unknown; region?: unknown; vintage?: unknown; listPrice?: unknown; price?: unknown; prices?: unknown }[] };
      currency = parseCurrency(j.currency);
      for (const w of Array.isArray(j.wines) ? j.wines : [])
        rows.push({ section: String(w.section ?? ""), name: String(w.name ?? ""), region: String(w.region ?? ""), vintage: toVintage(w.vintage), price: toPrice(w.prices ?? w.listPrice ?? w.price) });
    } catch {
      /* fall through to line parsing */
    }
  }

  if (!rows.length) {
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      const cur = l.match(/^CURRENCY\s*[=:]\s*(\S+)/i);
      if (cur) {
        currency = parseCurrency(cur[1]);
        continue;
      }
      if (!l.includes("|")) continue;
      const f = l.split("|").map((p) => p.trim());
      if (f.length >= 5) rows.push({ section: f[0], name: f[1], region: f[2], vintage: toVintage(f[3]) ?? toVintage(f[1]), price: toPrice(f[4]) });
      else rows.push({ section: "", name: f[0] ?? "", region: "", vintage: toVintage(f[1] ?? "") ?? toVintage(f[0]), price: toPrice(f[2]) }); // legacy name|vintage|price
    }
  }

  const wines: WineCandidate[] = [];
  for (const r of rows) {
    const name = r.name.replace(/^[\s\-•*\d.)]+(?=[A-Za-zÀ-ÿ])/, "").trim().slice(0, 120);
    if (name.replace(/[^a-z]/gi, "").length < 6) continue; // headers, fragments
    wines.push({
      id: `w${wines.length + 1}`,
      rawName: name,
      vintage: r.vintage,
      listPrice: r.price,
      region: r.region ? r.region.slice(0, 60) : undefined,
      section: r.section ? r.section.slice(0, 60) : undefined,
      ocrConfidence: r.price ? 0.85 : 0.7,
      needsReview: !r.price,
    });
  }
  return { wines, currency };
}
