import { NextRequest, NextResponse } from "next/server";
import type { WineCandidate } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 45;

const DEFAULT_MODEL = process.env.OPENROUTER_OCR_MODEL ?? "stealth/space-bunny-alpha";
const MAX_CHARS = 4_500_000; // ~3.3MB base64

type OcrWine = {
  name?: unknown;
  vintage?: unknown;
  listPrice?: unknown;
  confidence?: unknown;
};

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Vision OCR not configured yet — add OPENROUTER_API_KEY in Vercel env, or add wines manually below." },
      { status: 501 }
    );
  }

  try {
    const body = await req.json();
    const image = String(body.image ?? "");
    if (!image.startsWith("data:image/")) {
      return NextResponse.json({ error: "Send the photo as a data URL image." }, { status: 400 });
    }
    if (image.length > MAX_CHARS) {
      return NextResponse.json({ error: "Photo too large — try a smaller or compressed image." }, { status: 413 });
    }

    const model = String(body.model ?? DEFAULT_MODEL);
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://instant-paire.vercel.app",
        "X-Title": "Instant Paire",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a precise wine-list OCR API. Read the wine list photo and return ONLY JSON: {wines:[{name,vintage,listPrice,confidence}]}. Rules: name = wine name + producer as printed (no dish text, no headers); vintage = 4-digit year or null; listPrice = number only in the menu currency or null; confidence = 0-1 per row. Include every wine, even if price missing. Never invent wines. Max 40 rows.",
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
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("OpenRouter OCR failed", res.status, t.slice(0, 500));
      return NextResponse.json({ error: "List reading failed — try a clearer photo or add wines manually." }, { status: 502 });
    }

    const data = await res.json();
    const content: string = data.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content) as { wines?: OcrWine[] };
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

    return NextResponse.json({ wines, model });
  } catch (e) {
    console.error("OCR route error", e);
    return NextResponse.json({ error: "List reading failed — try again or add wines manually." }, { status: 500 });
  }
}
