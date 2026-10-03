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
  - `OCR_MODEL` (default `inclusionai/ling-3.0-flash-vl`) — vision list extraction, run with reasoning off and a token cap for speed
  - `OCR_FALLBACK_MODEL` (default `google/gemini-3.8-flash`) — one retry if the primary errors or finds no wines
  - (the old `OPENROUTER_OCR_MODEL` variable is no longer read - delete it from Vercel if set)
  - `ENRICH_MODEL` (default `openai/gpt-6-luna`) and `ENRICH_FALLBACK_MODEL` (default `google/gemini-3.8-flash`) — wine style/retail-price lookup. (The old `OPENROUTER_MODEL` variable is no longer read. `stealth/space-bunny-alpha` must not be used: mandatory max-effort reasoning, and it expires 2026-10-05.)
  - `JEV_MODEL` (default `typesafe/jev-1.13`) — System One pairing/value judgments via `POST https://openrouter.ai/api/alpha/decisions`
- `NEXT_PUBLIC_GA4_ID` — GA4 measurement ID. Empty = analytics disabled.
- `OPENAI_API_KEY` (legacy fallback for enrichment only — OpenRouter preferred).
- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or Vercel KV's `KV_REST_API_URL` + `KV_REST_API_TOKEN`) — **strongly recommended in production.** One shared store for rate limits, the per-device scan quota, the enrichment cache and the price index. Without it everything falls back to per-instance memory: limits reset on cold starts and the price index never accumulates.

## Debugging

Add `?debug` to the page URL (e.g. `https://instant-paire.vercel.app/?debug`) and run a scan: a dark panel under the results shows OCR model + timings, enrichment cache hits, which enrichment model answered, Jev timing, and the reason for any failure.

Reasoning control differs per model (some can turn it off, some are mandatory-reasoning), so `lib/openrouter.ts` tries reasoning-off, then low effort, then the model default, and remembers what worked.

## How it works

1. Photo is compressed on-device (max 1280px JPEG). OCR starts the moment it is chosen - while the user types their dish - via `POST /api/ocr` (compact `name|vintage|price` lines, bottle price preferred over glass, currency detected). With a dish already typed it flows straight into ranking and scrolls to the results; there is no manual review step (wines can be edited afterwards under the results).
2. `POST /api/rank` enriches (heuristic now, batched LLM when key set, cached), then calls Jev `typesafe/jev-1.13` via the OpenRouter Decisions API — one request, parallel `pair_*` Score + `value_*` Noul questions per wine — and blends Jev answers with data-quality reality (OCR, groundedness) into confidence bands High/Medium/Low. Falls back to built-in scoring if Jev is unreachable.
3. UI shows Best Match / Best Value / Wildcard + full ranked list. Low-OCR or unconfirmed entries are capped and flagged, never hidden.

## The data moat

Photo -> ranking is easy to copy (any chatbot can do it). What a chatbot can't do is what accumulates here:

- **Price index** (`lib/market.ts`) — every ranked list anonymously records (wine, list price in GBP, optional venue). Once a wine has been seen on 3+ menus, results show "typically £X on menus" and nudge the value score by how far this list is above/below the median.
- **Taste profile** (`lib/taste.ts`) — "Loved it / Not for me" ratings build a per-device category affinity that adjusts future rankings (max ±4 points).
- **Outcome data** (`/api/feedback`) — anonymous (wine, dish, rating) records, collected now so pairing scores can be calibrated against real outcomes later.

## Abuse protection

`lib/guard.ts` + `lib/store.ts`: per-IP rate limits on every route, and a server-side lifetime scan quota keyed by an anonymous httpOnly device cookie (the localStorage counter is UX only). Clearing cookies resets the device quota; the per-IP daily caps are the backstop.

## Paths

- `/` — the whole app
- `/api/rank` — ranking (enrich + Jev)
- `/api/ocr` — vision list extraction (501 without `OPENROUTER_API_KEY`)
- `/api/feedback` — anonymous "loved it / not for me" outcome capture
- `/api/billing/checkout` — 501 stub (Stripe upgrade point, gated by `lib/entitlements.ts`)

## Deploy

Import the GitHub repo into Vercel. No build config needed (`npm run build`). Add env vars in Vercel Project Settings when ready.

## Disclaimer

Scores are estimates from the photo plus wine knowledge. Always confirm the exact wine and price with staff. 18+ drink responsibly.
