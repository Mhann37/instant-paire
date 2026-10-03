"use client";

import { useMemo, useRef, useState } from "react";
import type { RankedWine, RankResponse, WineCandidate } from "@/lib/types";
import { track } from "@/lib/analytics";
import { getEntitlement, recordScan } from "@/lib/entitlements";
import { CURRENCIES, CURRENCY_CODES, parseCurrency, type CurrencyCode } from "@/lib/currency";
import { getTaste, recordRating } from "@/lib/taste";

type Step = "input" | "reading" | "review" | "ranking" | "results";

// Serverless platforms return HTML error pages for oversized payloads, timeouts and
// crashes. Never call res.json() blindly - read text, then parse, so the user sees
// a real message instead of "Unexpected token 'A'".
type ApiError = { error?: string };
type OcrOk = { wines?: WineCandidate[]; currency?: string; model?: string };

async function postJson<T extends object>(url: string, payload: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => "");
  let data: T | ApiError | null = null;
  try {
    data = text ? (JSON.parse(text) as T | ApiError) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const serverMsg = data && "error" in data && typeof data.error === "string" ? data.error : null;
    throw new Error(serverMsg ?? friendlyHttpError(res.status, text));
  }
  if (!data) throw new Error("Unexpected response from server. Try again, or add wines manually.");
  return data as T;
}

function friendlyHttpError(status: number, body: string): string {
  const hint = /payload|too large|body size/i.test(body)
    ? " Photo too large - try a closer shot of just the list."
    : /timeout|timed out/i.test(body)
      ? " The reading took too long. Try a tighter photo of the list."
      : "";
  if (status === 404) return `Endpoint not found (${urlTail()}) - the app may need redeploying.${hint}`;
  if (status === 413) return `Photo too large to process.${hint}`;
  if (status === 500 || status === 502 || status === 503) return `Server error (${status}).${hint} Add wines manually below meanwhile.`;
  return `Request failed (${status}).${hint}`;
}

function parsePrice(raw: string): number | undefined {
  const n = parseFloat(raw.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function urlTail(): string {
  return typeof window !== "undefined" ? window.location.pathname : "app";
}

export default function Home() {
  const [dish, setDish] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [wines, setWines] = useState<WineCandidate[]>([]);
  const [ranked, setRanked] = useState<RankedWine[]>([]);
  const [meta, setMeta] = useState<RankResponse["meta"] | null>(null);
  const [step, setStep] = useState<Step>("input");
  const [error, setError] = useState<string | null>(null);
  const [scansLeft, setScansLeft] = useState<number | null>(null);
  const [currency, setCurrency] = useState<CurrencyCode>("GBP");
  const [venue, setVenue] = useState("");
  const [rated, setRated] = useState<Record<string, 1 | -1>>({});
  const libraryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const canAnalyse = useMemo(() => dish.trim().length > 1 && (wines.length > 0 || imageUrl), [dish, wines, imageUrl]);

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    // Reset so picking the same file again (e.g. after an error) still fires onChange.
    e.target.value = "";
    void onFile(f);
  }

  async function onFile(f: File | undefined) {
    if (!f) return;
    setError(null);
    setStep("reading");
    track("scan_started", { has_dish: Boolean(dish.trim()) });
    try {
      const compressed = await compressImage(f);
      setImageUrl(compressed);
      const data = await postJson<OcrOk>("/api/ocr", { image: compressed });
      const parsed = (data.wines ?? []) as WineCandidate[];
      setWines(parsed);
      setCurrency(parseCurrency(data.currency));
      track("ocr_completed", { wine_count: parsed.length, model: data.model ?? "openrouter" });
      setStep("review");
      if (!parsed.length) setError("Couldn't read any wines - try a straighter, well-lit photo, or add them manually below.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Photo reading failed. Add wines manually below, then Find my pairing.");
      setStep("review");
    }
  }

  function compressImage(file: File, maxDim = 1400, quality = 0.75): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("canvas");
          ctx.drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Couldn't open that image. Try a JPG or PNG, or take a new photo."));
      };
      img.src = url;
    });
  }

  function updateWine(id: string, patch: Partial<WineCandidate>) {
    setWines((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch, needsReview: false, ocrConfidence: Math.max(w.ocrConfidence, 0.75) } : w)));
  }

  function removeWine(id: string) {
    setWines((ws) => ws.filter((w) => w.id !== id));
  }

  function addManual() {
    setWines((ws) => [...ws, { id: `w${Date.now()}`, rawName: "", vintage: undefined, listPrice: undefined, ocrConfidence: 0.7, needsReview: true }]);
  }

  async function analyse() {
    setError(null);
    const ent = getEntitlement();
    setScansLeft(ent.scansLeft);
    if (!ent.allowed) {
      track("paywall_hit", { scans_used: ent.scansUsed });
      setError("Free scan limit reached on this device. Paid plans coming soon.");
      return;
    }
    const clean = wines.filter((w) => w.rawName.trim().length > 3);
    if (!dish.trim() || !clean.length) {
      setError("Add what you're eating and at least one wine first.");
      return;
    }
    setStep("ranking");
    track("rank_requested", { wine_count: clean.length });
    try {
      const data = await postJson<RankResponse>("/api/rank", {
        dish: dish.trim(),
        wines: clean,
        currency,
        venue: venue.trim() || undefined,
        taste: { affinity: getTaste().affinity },
      });
      setRanked(data.ranked ?? []);
      setMeta(data.meta ?? null);
      setRated({});
      recordScan();
      setScansLeft(getEntitlement().scansLeft);
      setStep("results");
      track("rank_viewed", { top_score: data.ranked?.[0]?.finalScore ?? 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ranking failed - try again.");
      setStep("review");
    }
  }

  function rate(w: RankedWine, rating: 1 | -1) {
    if (rated[w.id]) return;
    setRated((r) => ({ ...r, [w.id]: rating }));
    recordRating(w.category, rating);
    track("wine_rated", { rating, category: w.category });
    // Anonymous outcome data for calibrating pairings; failure is irrelevant to the user.
    fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: w.rawName, vintage: w.vintage, category: w.category, dish: dish.trim(), rating }),
    }).catch(() => {});
  }

  function reset() {
    setRanked([]);
    setMeta(null);
    setStep(imageUrl ? "review" : "input");
  }

  const top3 = ranked.filter((w) => w.role).sort((a, b) => (a.role === "Best Match" ? -1 : b.role === "Best Match" ? 1 : 0));
  const rest = ranked.filter((w) => !w.role);

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <header className="mx-auto flex max-w-2xl items-center justify-between px-5 pt-8">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-900 text-sm font-bold text-white">iP</span>
          <div>
            <p className="text-[15px] font-semibold leading-none tracking-tight">Instant Paire</p>
            <p className="mt-1 text-xs text-neutral-500">Snap the list. Eat well.</p>
          </div>
        </div>
        {scansLeft !== null && <span className="rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-500">{scansLeft} free left</span>}
      </header>

      <main className="mx-auto max-w-2xl px-5 pb-16 pt-6">
        <section className="rounded-3xl border border-neutral-200 bg-white p-5 sm:p-6">
          <label htmlFor="dish" className="text-sm font-medium">What are you eating?</label>
          <input
            id="dish"
            value={dish}
            onChange={(e) => setDish(e.target.value)}
            placeholder="e.g. ribeye + fries"
            autoComplete="off"
            className="mt-2 w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-[15px] outline-none placeholder:text-neutral-400 focus:border-neutral-900"
          />
          <input
            value={venue}
            onChange={(e) => setVenue(e.target.value)}
            aria-label="Restaurant (optional)"
            placeholder="Restaurant (optional)"
            autoComplete="off"
            className="mt-2 w-full rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900"
          />

          <div className="mt-5">
            <p className="text-sm font-medium">Wine list photo</p>
            <div
              onClick={() => libraryRef.current?.click()}
              className="mt-2 flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-neutral-300 bg-neutral-50 px-4 py-8 text-center transition hover:border-neutral-900"
            >
              {imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imageUrl} alt="wine list" className="max-h-56 rounded-xl object-contain" />
              ) : (
                <>
                  <span className="text-xs font-medium uppercase tracking-widest text-neutral-400">Add photo</span>
                  <span className="mt-2 text-sm font-medium">Upload or take a photo</span>
                  <span className="text-xs text-neutral-500">Whole page works best, prices visible if possible</span>
                </>
              )}
            </div>
            {/* Two inputs on purpose: `capture` forces the camera on mobile and hides the photo library. */}
            <input
              ref={libraryRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => onFileInput(e)}
            />
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => onFileInput(e)}
            />
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => cameraRef.current?.click()}
                disabled={step === "reading"}
                className="rounded-2xl border border-neutral-200 bg-white py-3 text-sm font-medium transition hover:border-neutral-900 disabled:opacity-40"
              >
                Take photo
              </button>
              <button
                type="button"
                onClick={() => libraryRef.current?.click()}
                disabled={step === "reading"}
                className="rounded-2xl border border-neutral-200 bg-white py-3 text-sm font-medium transition hover:border-neutral-900 disabled:opacity-40"
              >
                {imageUrl ? "Choose another" : "Choose from library"}
              </button>
            </div>
          </div>

          {step === "reading" && (
            <div className="mt-4">
              <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-neutral-900" />
              </div>
              <p className="mt-2 text-xs text-neutral-500">Reading your wine list…</p>
            </div>
          )}

          {error && <p className="mt-4 rounded-2xl bg-neutral-900 px-4 py-3 text-sm text-white">{error}</p>}

          {(step === "review" || step === "ranking" || step === "results") && (
            <div className="mt-5">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Wines found ({wines.length}) — tap to fix</p>
                <div className="flex items-center gap-3">
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
                    aria-label="Menu currency"
                    className="rounded-lg border border-neutral-200 bg-white px-1.5 py-0.5 text-xs"
                  >
                    {CURRENCY_CODES.map((c) => (
                      <option key={c} value={c}>{c} {CURRENCIES[c].symbol.trim()}</option>
                    ))}
                  </select>
                  <button onClick={addManual} className="text-xs font-medium underline underline-offset-4">+ Add manually</button>
                </div>
              </div>
              <div className="mt-2 space-y-2">
                {wines.map((w) => (
                  <div key={w.id} className={`flex items-center gap-2 rounded-2xl border px-3 py-2 ${w.needsReview ? "border-neutral-900 bg-neutral-50" : "border-neutral-200 bg-white"}`}>
                    <input
                      value={w.rawName}
                      onChange={(e) => updateWine(w.id, { rawName: e.target.value })}
                      placeholder="Wine name + vintage"
                      className="w-full bg-transparent text-sm outline-none"
                    />
                    <input
                      defaultValue={w.listPrice ?? ""}
                      onChange={(e) => updateWine(w.id, { listPrice: parsePrice(e.target.value) })}
                      placeholder={CURRENCIES[currency].symbol.trim()}
                      inputMode="decimal"
                      aria-label="List price"
                      className="w-16 rounded-lg bg-neutral-100 px-2 py-1 text-right text-sm outline-none"
                    />
                    <button onClick={() => removeWine(w.id)} aria-label="remove" className="text-neutral-400 hover:text-black">×</button>
                  </div>
                ))}
                {!wines.length && <p className="text-sm text-neutral-500">No wines yet — add manually to continue.</p>}
              </div>
            </div>
          )}

          <button
            onClick={analyse}
            disabled={!canAnalyse || step === "ranking" || step === "reading"}
            className="mt-5 w-full rounded-2xl bg-neutral-900 py-4 text-[15px] font-semibold text-white transition enabled:hover:bg-black disabled:opacity-40"
          >
            {step === "ranking" ? "Pairing…" : "Find my pairing"}
          </button>
          <p className="mt-2 text-center text-[11px] text-neutral-400">Estimates only. Verify vintage and price before ordering. 18+ drink responsibly.</p>
        </section>

        {step === "results" && (
          <section className="mt-6">
            {meta?.warnings?.map((w) => (
              <p key={w} className="mb-2 rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-600">{w}</p>
            ))}
            <div className="grid gap-3">
              {top3.map((w) => (
                <RankCard key={w.id} wine={w} currency={meta?.currency ?? currency} featured rated={rated[w.id]} onRate={rate} />
              ))}
            </div>
            {rest.length > 0 && (
              <>
                <h2 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-widest text-neutral-400">Rest of the list</h2>
                <div className="grid gap-2">
                  {rest.map((w) => (
                    <RankCard key={w.id} wine={w} currency={meta?.currency ?? currency} rated={rated[w.id]} onRate={rate} />
                  ))}
                </div>
              </>
            )}
            <div className="mt-6 flex gap-2">
              <button onClick={reset} className="flex-1 rounded-2xl border border-neutral-200 bg-white py-3 text-sm font-medium">Change dish / fix wines</button>
              <button onClick={() => { setDish(""); setWines([]); setImageUrl(null); setRanked([]); setStep("input"); }} className="flex-1 rounded-2xl bg-neutral-900 py-3 text-sm font-medium text-white">Start over</button>
            </div>
          </section>
        )}

        <footer className="mt-12 border-t border-neutral-100 pt-6 text-center">
          <p className="text-sm font-semibold tracking-tight">Instant Paire</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-neutral-400">
            Pairing and value scores are estimates from the photo plus built-in wine knowledge. Always confirm the exact wine and price with the menu or staff.
          </p>
          <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-neutral-400">
            We anonymously save wine names and list prices (we don&apos;t store your photo or any personal details) to build a market price guide.
          </p>
        </footer>
      </main>
    </div>
  );
}

function RankCard({ wine, featured, currency, rated, onRate }: { wine: RankedWine; featured?: boolean; currency: CurrencyCode; rated?: 1 | -1; onRate: (w: RankedWine, r: 1 | -1) => void }) {
  const sym = CURRENCIES[currency].symbol;
  const bandColor = wine.confidenceBand === "High" ? "bg-neutral-900 text-white" : wine.confidenceBand === "Medium" ? "bg-neutral-200 text-neutral-800" : "bg-neutral-100 text-neutral-500";
  return (
    <article className={`rounded-3xl border p-5 ${featured ? "border-neutral-900" : "border-neutral-200"} bg-white`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          {wine.role && <span className={`mb-1.5 inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${featured ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-700"}`}>{wine.role}</span>}
          <h3 className="text-lg font-semibold leading-snug tracking-tight">{wine.rawName || "Unnamed wine"}</h3>
          <p className="mt-0.5 text-xs text-neutral-500">
            {wine.listPrice ? `${sym}${wine.listPrice} on list` : "Price not read"}{wine.typicalRetailGBP ? ` · ~£${wine.typicalRetailGBP} retail est.` : ""} · {wine.style}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-2xl font-semibold tabular-nums">{wine.finalScore}</div>
          <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${bandColor}`}>{Math.round(wine.confidence * 100)}% · {wine.confidenceBand}</span>
        </div>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-neutral-700">{wine.why}</p>
      {wine.flags.length > 0 && <p className="mt-2 text-xs text-neutral-400">{wine.flags.join(" · ")}</p>}
      <div className="mt-3 flex gap-4 text-xs tabular-nums text-neutral-500">
        <span>Pairing {wine.pairingFit.toFixed(1)}/2</span>
        <span>Value {Math.round(wine.valueScore * 100)}%</span>
        <span className="ml-auto">OCR {Math.round(wine.ocrConfidence * 100)}%</span>
      </div>
      {wine.market && (
        <p className="mt-2 text-xs text-neutral-500">
          Typically £{wine.market.medianGBP} on menus (£{wine.market.minGBP}-£{wine.market.maxGBP}, {wine.market.n} lists)
        </p>
      )}
      <div className="mt-3 flex items-center gap-2 text-xs">
        {rated ? (
          <span className="text-neutral-400">Thanks - your taste profile is updated.</span>
        ) : (
          <>
            <span className="text-neutral-400">Ordered it?</span>
            <button onClick={() => onRate(wine, 1)} className="rounded-full border border-neutral-200 px-2.5 py-1 font-medium hover:border-neutral-900">Loved it</button>
            <button onClick={() => onRate(wine, -1)} className="rounded-full border border-neutral-200 px-2.5 py-1 font-medium hover:border-neutral-900">Not for me</button>
          </>
        )}
      </div>
    </article>
  );
}
