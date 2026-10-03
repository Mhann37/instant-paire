# Instant Paire

Snap any wine list, say what you're eating, get the best-suited and best-valued bottles — with confidence scores.

Live: `https://instant-paire.vercel.app` (after Vercel import)

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Env (all optional except OCR — app degrades gracefully without keys)

Copy `.env.example` to `.env.local`:

- `OPENROUTER_API_KEY` — **required**. Powers photo OCR, wine enrichment, and live Jev decisioning. Models:
  - `OPENROUTER_OCR_MODEL` (default `stealth/space-bunny-alpha`) — vision list extraction
  - `OPENROUTER_MODEL` (default `stealth/space-bunny-alpha`) — enrichment
  - `JEV_MODEL` (default `typesafe/jev-1.13`) — System One pairing/value judgments via `POST https://openrouter.ai/api/alpha/decisions`
- `NEXT_PUBLIC_GA4_ID` — GA4 measurement ID. Empty = analytics disabled.
- `OPENAI_API_KEY` (legacy fallback for enrichment only — OpenRouter preferred).

## How it works

1. Photo is compressed on-device (max 1600px JPEG), then read by a vision model via OpenRouter (`POST /api/ocr` -> structured `{name, vintage, listPrice, confidence}` JSON).
2. `POST /api/rank` enriches (heuristic now, batched LLM when key set, cached), then calls Jev `typesafe/jev-1.13` via the OpenRouter Decisions API — one request, parallel `pair_*` Score + `value_*` Noul questions per wine — and blends Jev answers with data-quality reality (OCR, groundedness) into confidence bands High/Medium/Low. Falls back to built-in scoring if Jev is unreachable.
3. UI shows Best Match / Best Value / Wildcard + full ranked list. Low-OCR or unconfirmed entries are capped and flagged, never hidden.

## Paths

- `/` — the whole app
- `/api/rank` — ranking (enrich + Jev)
- `/api/ocr` — vision list extraction (501 without `OPENROUTER_API_KEY`)
- `/api/billing/checkout` — 501 stub (Stripe upgrade point, gated by `lib/entitlements.ts`)

## Deploy

Import the GitHub repo into Vercel. No build config needed (`npm run build`). Add env vars in Vercel Project Settings when ready.

## Disclaimer

Scores are estimates from the photo plus wine knowledge. Always confirm the exact wine and price with staff. 18+ drink responsibly.
