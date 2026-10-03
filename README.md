# Instant Paire

Snap any wine list, say what you're eating, get the best-suited and best-valued bottles — with confidence scores.

Live: `https://instant-paire.vercel.app` (after Vercel import)

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Env (all optional — app works without keys)

Copy `.env.example` to `.env.local`:

- `NEXT_PUBLIC_GA4_ID` — GA4 measurement ID. Empty = analytics disabled.
- `OPENAI_API_KEY` (+ `OPENAI_MODEL`, default `gpt-4o-mini`) — upgrades wine enrichment from built-in heuristics to live retail + quality data.
- `TYPESAFE_API_KEY` — upgrades decisioning from the deterministic fallback to real Jev System One judgments. See `lib/jev.ts` (`jevRequestBody`).

## How it works

1. Photo is read on-device with Tesseract.js (`lib/ocr-parse.ts`), parsed into `{rawName, vintage, listPrice, ocrConfidence}`.
2. `POST /api/rank` enriches (heuristic now, batched LLM when key set, cached) and scores pairing/value/quality with confidence bands High/Medium/Low.
3. UI shows Best Match / Best Value / Wildcard + full ranked list. Low-OCR or unconfirmed entries are capped and flagged, never hidden.

## Paths

- `/` — the whole app
- `/api/rank` — ranking
- `/api/ocr` — 501 stub (server OCR upgrade point)
- `/api/billing/checkout` — 501 stub (Stripe upgrade point, gated by `lib/entitlements.ts`)

## Deploy

Import the GitHub repo into Vercel. No build config needed (`npm run build`). Add env vars in Vercel Project Settings when ready.

## Disclaimer

Scores are estimates from the photo plus wine knowledge. Always confirm the exact wine and price with staff. 18+ drink responsibly.
