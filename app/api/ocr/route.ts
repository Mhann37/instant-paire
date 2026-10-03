import { NextRequest, NextResponse } from "next/server";
import type { WineCandidate } from "@/lib/types";
import { parseCurrency } from "@/lib/currency";
import { FREE_SCANS_LIFETIME } from "@/lib/limits";
import { peek } from "@/lib/store";
import { getDevice, rateLimit, setDeviceCookie } from "@/lib/guard";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_MODEL = process.env.OPENROUTER_OCR_MODEL ?? "stealth/space-bunny-alpha";
// Vercel serverless request body limit is ~4.5MB; base64 inflates by ~1.33x.
const MAX_CHARS = 3_400_000;

type OcrWine = {
  name?: unknown;
  vintage?: unknown;
  listPrice?: unknown;
  confidence?: unknown;
};

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

  const model = DEFAULT_MODEL;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55_000);
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://instant-paire.vercel.app",
        "X-Title": "Instant Paire",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a precise wine-list OCR API. Read the wine list photo and return ONLY JSON: {currency,wines:[{name,vintage,listPrice,confidence}]}. currency = ISO code of the menu prices (GBP, EUR, USD, AUD, CAD or CHF), inferred from symbols; default GBP. Rules: name = wine name + producer as printed (no dish text, no headers); vintage = 4-digit year or null; listPrice = number only in the menu currency or null; confidence = 0-1 per row. Include every wine, even if price missing. Never invent wines. Max 40 rows.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract all wines from this wine list photo as JSON." },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
      }),
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("OpenRouter OCR failed", res.status, t.slice(0, 800));
      if (res.status === 401 || res.status === 403) return fail("OpenRouter key was rejected. Check OPENROUTER_API_KEY in Vercel.", 502);
      if (res.status === 404 || /no endpoints|model not found/i.test(t)) return fail(`Model "${model}" is unavailable on OpenRouter. Set OPENROUTER_OCR_MODEL to a vision model.`, 502);
      if (res.status === 429) return fail("Rate limited by the model provider - try again in a moment.", 429);
      return fail("List reading failed upstream. Try again, or add wines manually.", 502);
    }

    const data = await res.json();
    const content: string = data?.choices?.[0]?.message?.content ?? "";
    let parsed: { wines?: OcrWine[]; currency?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      console.error("OCR model returned non-JSON", content.slice(0, 400));
      return fail("Model returned an unexpected format. Try again or add wines manually.", 502);
    }

    const arr = Array.isArray(parsed.wines) ? parsed.wines : [];
    const wines: WineCandidate[] = arr.slice(0, 40).flatMap((w, i) => {
      const name = String(w.name ?? "").trim().slice(0, 120);
      if (name.replace(/[^a-z]/gi, "").length < 6) return [];
      const vintage = /^(19\d{2}|20[0-2]\d)$/.test(String(w.vintage ?? "")) ? String(w.vintage) : undefined;
      const price = Number(w.listPrice);
      const listPrice = Number.isFinite(price) && price >= 5 && price <= 5000 ? price : undefined;
      const conf = Number(w.confidence);
      const ocrConfidence = Number.isFinite(conf) ? Math.max(0.3, Math.min(0.99, conf > 1 ? conf / 100 : conf)) : 0.82;
      return [
        {
          id: `w${i + 1}`,
          rawName: name,
          vintage,
          listPrice,
          ocrConfidence: Math.round(ocrConfidence * 100) / 100,
          needsReview: ocrConfidence < 0.75 || !listPrice,
        },
      ];
    });

    return NextResponse.json({ wines, currency: parseCurrency(parsed.currency), model });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    console.error("OCR route error", aborted ? "timeout" : e);
    return fail(aborted ? "Reading timed out. Try a tighter photo of the list." : "List reading failed. Try again or add wines manually.", 500);
  }
}