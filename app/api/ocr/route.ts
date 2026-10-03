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
const MAX_CHARS = 3_400_000;
const MAX_WINES = 40;

const SYSTEM_PROMPT = [
  "You are a precise wine-list OCR engine. Reply with plain text only - no commentary, no markdown.",
  "Line 1: CURRENCY=<ISO code of the menu prices: GBP, EUR, USD, AUD, CAD or CHF; GBP if unsure>.",
  `Then one wine per line, exactly: name|vintage|price (max ${MAX_WINES} lines).`,
  "name = wine name + producer exactly as printed (no tasting notes, headers or food).",
  "vintage = 4-digit year, or empty (NV/none).",
  "price = the BOTTLE price as a plain number, or empty. If a glass price and a bottle price are both shown, use the bottle price.",
  "Include every wine even if the price is missing. Never invent wines.",
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

  let body: { image?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("Could not read the upload. Try a smaller photo.", 400);
  }

  const image = typeof body.image === "string" ? body.image : "";
  if (!image.startsWith("data:image/")) return fail("Send the photo as an image data URL.", 400);
  if (image.length > MAX_CHARS) return fail("Photo too large - take a closer shot of just the wine list.", 413);

  const started = Date.now();
  let lastErr: OcrError | null = null;
  // Models with mandatory reasoning (e.g. Gemini Flash) spend part of max_tokens on thinking, hence the bigger cap.
  const attempts: [string, number, number][] = [[PRIMARY_MODEL, PRIMARY_TIMEOUT_MS, 2400]];
  if (FALLBACK_MODEL && FALLBACK_MODEL !== PRIMARY_MODEL) attempts.push([FALLBACK_MODEL, FALLBACK_TIMEOUT_MS, 8000]);

  for (const [model, timeoutMs, maxTokens] of attempts) {
    try {
      const parsed = await readMenu(model, image, apiKey, timeoutMs, maxTokens);
      if (!parsed.wines.length) throw new OcrError("No wines found in the photo.", 422);
      console.info("ocr ok", JSON.stringify({ model, wines: parsed.wines.length, ms: Date.now() - started, fellBack: model !== PRIMARY_MODEL }));
      return NextResponse.json({ wines: parsed.wines, currency: parsed.currency, model, ms: Date.now() - started });
    } catch (e) {
      lastErr = e instanceof OcrError ? e : new OcrError("List reading failed. Try again or add wines manually.", 500);
      console.error("ocr attempt failed", JSON.stringify({ model, ms: Date.now() - started, status: lastErr.status, msg: lastErr.message }));
      if (!lastErr.retryable) break;
    }
  }
  const err = lastErr ?? new OcrError("List reading failed. Try again or add wines manually.", 500);
  return fail(err.message, err.status);
}

async function readMenu(model: string, image: string, apiKey: string, timeoutMs: number, maxTokens: number): Promise<Parsed> {
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
              { type: "text", text: "Transcribe every wine on this list." },
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
  // "£22 glass / £110" -> the bottle is the biggest figure.
  const nums = (String(raw ?? "").replace(/,(?=\d{3}\b)/g, "").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const n = nums.length ? Math.max(...nums) : NaN;
  return Number.isFinite(n) && n >= 5 && n <= 5000 ? n : undefined;
}

function toVintage(raw: unknown): string | undefined {
  const m = String(raw ?? "").match(/\b(19\d{2}|20[0-2]\d)\b/);
  return m ? m[1] : undefined;
}

function parseMenu(content: string): Parsed {
  const text = content.replace(/```[a-z]*\n?/gi, "").trim();
  let currency: CurrencyCode = "GBP";
  const rows: { name: string; vintage?: string; price?: number }[] = [];

  if (text.startsWith("{")) {
    // A fallback model ignoring the line format and answering with JSON.
    try {
      const j = JSON.parse(text) as { currency?: unknown; wines?: { name?: unknown; vintage?: unknown; listPrice?: unknown; price?: unknown }[] };
      currency = parseCurrency(j.currency);
      for (const w of Array.isArray(j.wines) ? j.wines : []) rows.push({ name: String(w.name ?? ""), vintage: toVintage(w.vintage), price: toPrice(w.listPrice ?? w.price) });
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
      const [name, vintage, price] = l.split("|").map((p) => p.trim());
      rows.push({ name: name ?? "", vintage: toVintage(vintage ?? "") ?? toVintage(name), price: toPrice(price) });
    }
  }

  const seen = new Set<string>();
  const wines: WineCandidate[] = [];
  for (const r of rows) {
    const name = r.name.replace(/^[\s\-•*\d.)]+(?=[A-Za-zÀ-ÿ])/, "").trim().slice(0, 120);
    if (name.replace(/[^a-z]/gi, "").length < 6) continue; // headers, fragments
    const dedupe = `${name.toLowerCase()}|${r.vintage ?? ""}|${r.price ?? ""}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const ocrConfidence = r.price ? 0.85 : 0.7;
    wines.push({
      id: `w${wines.length + 1}`,
      rawName: name,
      vintage: r.vintage,
      listPrice: r.price,
      ocrConfidence,
      needsReview: !r.price,
    });
    if (wines.length >= MAX_WINES) break;
  }
  return { wines, currency };
}
