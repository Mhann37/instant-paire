"use client";

import { useEffect, useRef, useState } from "react";
import type { RankedWine, RankResponse, WineCandidate } from "@/lib/types";
import { track } from "@/lib/analytics";
import { getEntitlement, recordScan } from "@/lib/entitlements";
import { CURRENCIES, CURRENCY_CODES, parseCurrency, type CurrencyCode } from "@/lib/currency";
import { getTaste, recordRating } from "@/lib/taste";
import { CategoryDot, MiniRow, RankCard } from "@/components/Results";

type Phase = "input" | "working" | "results";
type Stage = "reading" | "pairing";
type OcrResult = { wines: WineCandidate[]; currency: CurrencyCode; info: string };

// Serverless platforms return HTML error pages for oversized payloads, timeouts and
// crashes. Never call res.json() blindly - read text, then parse, so the user sees
// a real message instead of "Unexpected token 'A'".
type ApiError = { error?: string };
type OcrOk = { wines?: WineCandidate[]; currency?: string; model?: string; ms?: number };

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


function compressImage(file: File, maxDim = 1280, quality = 0.72): Promise<string> {
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

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function Home() {
  const [dish, setDish] = useState("");
  const [venue, setVenue] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [wines, setWines] = useState<WineCandidate[]>([]);
  const [currency, setCurrency] = useState<CurrencyCode>("GBP");
  const [ranked, setRanked] = useState<RankedWine[]>([]);
  const [meta, setMeta] = useState<RankResponse["meta"] | null>(null);
  const [phase, setPhase] = useState<Phase>("input");
  const [stage, setStage] = useState<Stage>("reading");
  const [editing, setEditing] = useState(false); // re-open the input card while viewing results
  const [manual, setManual] = useState(false); // show the wine editor (no photo, or reading failed)
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scansLeft, setScansLeft] = useState<number | null>(null);
  const [rated, setRated] = useState<Record<string, 1 | -1>>({});
  const [debugLines, setDebugLines] = useState<string[]>([]); // only populated with ?debug in the URL

  const libraryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const dishRef = useRef<HTMLInputElement>(null);
  const workRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  // The OCR call starts the moment a photo is chosen (while the user is still typing their dish).
  const ocr = useRef<{ promise: Promise<OcrResult> | null; status: "idle" | "reading" | "ready" | "failed" }>({ promise: null, status: "idle" });
  const ocrInfo = useRef("");
  const photoId = useRef(0);
  const runId = useRef(0);

  const hasInput = Boolean(imageUrl) || wines.length > 0;
  const canRun = dish.trim().length > 1 && hasInput;
  const showCard = phase === "input" || editing;

  // Long waits get a reassuring note.
  useEffect(() => {
    if (phase !== "working") return;
    const t = setTimeout(() => setSlow(true), 12_000);
    return () => clearTimeout(t);
  }, [phase]);

  // Bring the progress panel into view when work starts, and the results when they land.
  useEffect(() => {
    if (phase !== "working") return;
    const id = requestAnimationFrame(() => workRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" }));
    return () => cancelAnimationFrame(id);
  }, [phase]);

  useEffect(() => {
    if (phase !== "results") return;
    const id = requestAnimationFrame(() => {
      const el = resultsRef.current;
      if (!el) return;
      el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
      el.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [phase, ranked]);

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    // Reset so picking the same file again (e.g. after an error) still fires onChange.
    e.target.value = "";
    if (f) startPhoto(f);
  }

  function startPhoto(f: File) {
    const id = ++photoId.current;
    runId.current++; // cancel any in-flight run for the previous photo
    setError(null);
    setWines([]);
    setManual(false);
    setPhase((p) => (p === "working" ? "input" : p));
    track("scan_started", { has_dish: Boolean(dish.trim()) });
    const t0 = performance.now();

    const promise = (async (): Promise<OcrResult> => {
      const compressed = await compressImage(f);
      if (id === photoId.current) setImageUrl(compressed);
      const data = await postJson<OcrOk>("/api/ocr", { image: compressed });
      const parsed = data.wines ?? [];
      if (!parsed.length) throw new Error("Couldn't read any wines - try a straighter, well-lit photo, or type them in.");
      track("ocr_completed", { wine_count: parsed.length, model: data.model ?? "openrouter", ms: Math.round(performance.now() - t0) });
      return { wines: parsed, currency: parseCurrency(data.currency), info: `ocr ${data.model ?? "?"} server ${data.ms ?? "?"}ms, total ${Math.round(performance.now() - t0)}ms` };
    })();
    ocr.current = { promise, status: "reading" };
    promise.then(
      (r) => {
        if (id !== photoId.current) return;
        ocr.current.status = "ready";
        setWines(r.wines);
        setCurrency(r.currency);
        ocrInfo.current = r.info;
      },
      (e) => {
        if (id !== photoId.current) return;
        ocr.current.status = "failed";
        setError(e instanceof Error ? e.message : "Photo reading failed. Type the wines in instead.");
        setManual(true);
        setPhase("input");
      },
    );
    promise.catch(() => {}); // handled above; avoid unhandled-rejection noise for stale photos

    // Dish already typed: no more taps needed.
    if (dish.trim().length > 1) void run();
  }

  async function run() {
    setError(null);
    const ent = getEntitlement();
    setScansLeft(ent.scansLeft);
    if (!ent.allowed) {
      track("paywall_hit", { scans_used: ent.scansUsed });
      setError("Free scan limit reached on this device. Paid plans coming soon.");
      return;
    }
    if (dish.trim().length < 2) {
      setError("Tell us what you're eating first.");
      dishRef.current?.focus();
      return;
    }
    const rid = ++runId.current;
    const t0 = performance.now();
    setEditing(false);
    setSlow(false);
    setStage("reading");
    setPhase("working");

    let list = wines;
    let cur = currency;
    if (ocr.current.status === "reading" && ocr.current.promise) {
      try {
        const r = await ocr.current.promise;
        if (rid !== runId.current) return;
        list = r.wines;
        cur = r.currency;
      } catch {
        return; // the photo handler already surfaced the error and reset the phase
      }
    }

    const clean = list.filter((w) => w.rawName.trim().length > 3);
    if (!clean.length) {
      setError("Add a photo of the wine list, or type a few wines in.");
      setManual(true);
      setPhase("input");
      return;
    }

    setStage("pairing");
    track("rank_requested", { wine_count: clean.length });
    try {
      const data = await postJson<RankResponse>("/api/rank", {
        dish: dish.trim(),
        wines: clean,
        currency: cur,
        venue: venue.trim() || undefined,
        taste: { affinity: getTaste().affinity },
      });
      if (rid !== runId.current) return;
      setRanked(data.ranked ?? []);
      setMeta(data.meta ?? null);
      setRated({});
      setDebugLines(new URLSearchParams(window.location.search).has("debug") ? [ocrInfo.current, ...(data.meta?.diagnostics ?? []), `total ${Math.round(performance.now() - t0)}ms`].filter(Boolean) : []);
      recordScan();
      setScansLeft(getEntitlement().scansLeft);
      setPhase("results");
      track("rank_viewed", { top_score: data.ranked?.[0]?.finalScore ?? 0, total_ms: Math.round(performance.now() - t0) });
    } catch (e) {
      if (rid !== runId.current) return;
      setError(e instanceof Error ? e.message : "Ranking failed - try again.");
      setManual(true);
      setPhase("input");
    }
  }

  function updateWine(id: string, patch: Partial<WineCandidate>) {
    setWines((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch, needsReview: false, ocrConfidence: Math.max(w.ocrConfidence, 0.75) } : w)));
  }

  function removeWine(id: string) {
    setWines((ws) => ws.filter((w) => w.id !== id));
  }

  function addManual() {
    setManual(true);
    setWines((ws) => [...ws, { id: `w${Date.now()}`, rawName: "", vintage: undefined, listPrice: undefined, ocrConfidence: 0.7, needsReview: true }]);
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

  function anotherDish() {
    setEditing(true);
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
      dishRef.current?.select();
    });
  }

  function startOver() {
    runId.current++;
    photoId.current++;
    ocr.current = { promise: null, status: "idle" };
    setDish("");
    setVenue("");
    setWines([]);
    setImageUrl(null);
    setRanked([]);
    setMeta(null);
    setError(null);
    setManual(false);
    setEditing(false);
    setPhase("input");
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }

  const sym = CURRENCIES[currency].symbol.trim();
  const top3 = ranked.filter((w) => w.role).sort((a, b) => (a.role === "Best Match" ? -1 : b.role === "Best Match" ? 1 : 0));
  const rest = ranked.filter((w) => !w.role);
  const cardCurrency = meta?.currency ?? currency;

  const wineEditor = (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Wines ({wines.length}) — tap to fix</p>
        <div className="flex items-center gap-3">
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
            aria-label="Menu currency"
            className="rounded-lg border border-line bg-white px-1.5 py-0.5 text-xs"
          >
            {CURRENCY_CODES.map((c) => (
              <option key={c} value={c}>{c} {CURRENCIES[c].symbol.trim()}</option>
            ))}
          </select>
          <button onClick={addManual} className="text-xs font-medium text-claret underline underline-offset-4">+ Add wine</button>
        </div>
      </div>
      <div className="mt-2 space-y-2">
        {wines.map((w) => (
          <div key={w.id} className={`flex items-center gap-2 rounded-2xl border px-3 py-2 ${w.needsReview ? "border-claret/50 bg-[#fbf3ee]" : "border-line bg-white"}`}>
            <input
              value={w.rawName}
              onChange={(e) => updateWine(w.id, { rawName: e.target.value })}
              placeholder="Wine name + vintage"
              className="w-full bg-transparent text-sm outline-none"
            />
            <input
              defaultValue={w.listPrice ?? ""}
              onChange={(e) => updateWine(w.id, { listPrice: parsePrice(e.target.value) })}
              placeholder={sym}
              inputMode="decimal"
              aria-label="List price"
              className="w-16 rounded-lg bg-[#f4ede4] px-2 py-1 text-right text-sm outline-none"
            />
            <button onClick={() => removeWine(w.id)} aria-label="remove" className="text-mute hover:text-ink">×</button>
          </div>
        ))}
        {!wines.length && <p className="text-sm text-mute">No wines yet — add one to continue.</p>}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-cream text-ink">
      <header className="mx-auto flex max-w-2xl items-center justify-between px-5 pt-7">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-claret to-claret-deep text-sm font-bold text-white">iP</span>
          <div>
            <p className="text-[15px] font-semibold leading-none tracking-tight">Instant Paire</p>
            <p className="mt-1 text-xs text-mute">Snap the list. Eat well.</p>
          </div>
        </div>
        {scansLeft !== null && <span className="rounded-full border border-line bg-white px-3 py-1 text-xs text-mute">{scansLeft} free left</span>}
      </header>

      <main className="mx-auto max-w-2xl px-5 pb-16 pt-5">
        {/* Collapsed summary once we're working / showing results */}
        {!showCard && (
          <div className="flex items-center gap-3 rounded-2xl border border-line bg-white p-3">
            {imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt="your wine list" className="h-11 w-11 rounded-xl object-cover" />
            ) : (
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-[#f4ede4] text-lg" aria-hidden>🍷</span>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{dish}</p>
              <p className="truncate text-xs text-mute">{venue ? `${venue} · ` : ""}{wines.length ? `${wines.length} wines read` : "Reading your list…"}</p>
            </div>
            {phase === "results" && (
              <button onClick={() => setEditing(true)} className="ml-auto text-sm font-semibold text-claret">Edit</button>
            )}
          </div>
        )}

        {showCard && (
          <section className="rounded-3xl border border-line bg-white p-5 shadow-[0_8px_30px_-18px_rgba(78,17,40,.35)] sm:p-6">
            <label htmlFor="dish" className="text-sm font-medium">What are you eating?</label>
            <input
              id="dish"
              ref={dishRef}
              value={dish}
              onChange={(e) => setDish(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canRun) void run(); }}
              placeholder="e.g. ribeye + fries"
              autoComplete="off"
              enterKeyHint="go"
              className="mt-2 w-full rounded-2xl border border-line bg-cream px-4 py-3 text-[15px] outline-none placeholder:text-mute/60 focus:border-claret"
            />
            <input
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
              aria-label="Restaurant (optional)"
              placeholder="Restaurant (optional)"
              autoComplete="off"
              className="mt-2 w-full rounded-2xl border border-line bg-cream px-4 py-2.5 text-sm outline-none placeholder:text-mute/60 focus:border-claret"
            />

            <div className="mt-5">
              <p className="text-sm font-medium">Wine list photo</p>
              <div
                onClick={() => libraryRef.current?.click()}
                className="mt-2 flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-claret/30 bg-cream px-4 py-8 text-center transition hover:border-claret"
              >
                {imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={imageUrl} alt="wine list" className="max-h-56 rounded-xl object-contain" />
                ) : (
                  <>
                    <span className="text-xs font-medium uppercase tracking-widest text-claret/60">Add photo</span>
                    <span className="mt-2 text-sm font-medium">Upload or take a photo</span>
                    <span className="text-xs text-mute">Whole page works best, prices visible if possible</span>
                  </>
                )}
              </div>
              {/* Two inputs on purpose: `capture` forces the camera on mobile and hides the photo library. */}
              <input ref={libraryRef} type="file" accept="image/*" className="hidden" onChange={onFileInput} />
              <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFileInput} />
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => cameraRef.current?.click()} className="rounded-2xl border border-line bg-white py-3 text-sm font-medium transition hover:border-claret">
                  Take photo
                </button>
                <button type="button" onClick={() => libraryRef.current?.click()} className="rounded-2xl border border-line bg-white py-3 text-sm font-medium transition hover:border-claret">
                  {imageUrl ? "Choose another" : "Choose from library"}
                </button>
              </div>
              {!manual && wines.length === 0 && (
                <button type="button" onClick={addManual} className="mt-3 w-full text-center text-xs font-medium text-mute underline underline-offset-4">
                  No photo? Type the wines in instead
                </button>
              )}
            </div>

            {error && <p role="alert" className="mt-4 rounded-2xl bg-claret px-4 py-3 text-sm text-white">{error}</p>}

            {(manual || (editing && wines.length > 0)) && <div className="mt-5">{wineEditor}</div>}

            <button
              onClick={() => void run()}
              disabled={!canRun}
              className="mt-5 w-full rounded-2xl bg-gradient-to-br from-claret to-claret-deep py-4 text-[15px] font-semibold text-white shadow-[0_8px_20px_-10px_rgba(122,31,61,.8)] transition enabled:active:scale-[0.99] disabled:opacity-40 disabled:shadow-none"
            >
              {editing ? "Update my pairing" : "Find my pairing"}
            </button>
            <p className="mt-2 text-center text-[11px] text-mute">Estimates only. Verify vintage and price before ordering. 18+ drink responsibly.</p>
          </section>
        )}

        {phase === "working" && (
          <section ref={workRef} aria-live="polite" className="mt-5 scroll-mt-4 rounded-3xl border border-line bg-white p-5">
            <ol className="space-y-3">
              {([["reading", "Reading the menu"], ["pairing", `Pairing with ${dish.trim() || "your dish"}`]] as const).map(([key, label]) => {
                const done = key === "reading" && stage === "pairing";
                const active = key === stage;
                return (
                  <li key={key} className={`flex items-center gap-3 text-sm ${done || active ? "text-ink" : "text-mute"}`}>
                    <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${done ? "bg-wgreen text-white" : active ? "bg-claret text-white" : "bg-[#efe6da] text-mute"}`}>
                      {done ? "✓" : key === "reading" ? 1 : 2}
                    </span>
                    <span className={active ? "font-semibold" : ""}>{label}{active ? "…" : ""}</span>
                  </li>
                );
              })}
            </ol>
            <div className="relative mt-4 h-1.5 overflow-hidden rounded-full bg-[#efe6da]">
              <div className="sweep absolute inset-y-0 left-0 w-1/3 rounded-full bg-gradient-to-r from-claret to-gold" />
            </div>
            <p className="mt-3 text-xs text-mute">{slow ? "Still working - long lists take a little longer." : "Usually takes a few seconds."}</p>
            <div className="mt-5 space-y-3" aria-hidden>
              {[0, 1].map((i) => (
                <div key={i} className="h-24 animate-pulse rounded-[22px] bg-[#f4ede4]" />
              ))}
            </div>
          </section>
        )}

        {phase === "results" && (
          <section className="mt-6">
            <div ref={resultsRef} tabIndex={-1} className="scroll-mt-4 outline-none">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-mute">Your pairings</h2>
              {meta?.warnings?.map((w) => (
                <p key={w} className="mb-2 rounded-2xl border border-line bg-white px-4 py-2 text-xs text-mute">{w}</p>
              ))}
              <div className="grid gap-3">
                {top3.map((w, i) => (
                  <RankCard key={w.id} wine={w} index={i} currency={cardCurrency} rated={rated[w.id]} onRate={rate} />
                ))}
              </div>
              {rest.length > 0 && (
                <>
                  <h2 className="mb-2 mt-7 text-xs font-semibold uppercase tracking-[0.14em] text-mute">Rest of the list</h2>
                  <div className="grid gap-2">
                    {rest.map((w, i) => (
                      <MiniRow key={w.id} wine={w} index={top3.length + i} currency={cardCurrency} />
                    ))}
                  </div>
                </>
              )}
            </div>

            {debugLines.length > 0 && (
              <pre className="mt-6 overflow-x-auto whitespace-pre-wrap rounded-2xl bg-ink p-4 text-[11px] leading-relaxed text-[#e9cbd5]">{debugLines.join("\n")}</pre>
            )}

            <details className="mt-6 rounded-2xl border border-line bg-white p-4">
              <summary className="cursor-pointer text-sm font-medium">
                <CategoryDot category="red" /> {wines.length} wines read — something wrong? Edit
              </summary>
              <div className="mt-3">{wineEditor}</div>
              <button onClick={() => void run()} className="mt-4 w-full rounded-2xl border border-claret py-3 text-sm font-semibold text-claret">
                Re-run pairing
              </button>
            </details>

            <div className="mt-5 flex gap-2">
              <button onClick={startOver} className="flex-1 rounded-2xl border border-line bg-white py-3 text-sm font-medium">Start over</button>
              <button onClick={anotherDish} className="flex-1 rounded-2xl bg-gradient-to-br from-claret to-claret-deep py-3 text-sm font-semibold text-white">Try another dish</button>
            </div>
          </section>
        )}

        <footer className="mt-12 border-t border-line pt-6 text-center">
          <p className="text-sm font-semibold tracking-tight">Instant Paire</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-mute">
            Pairing and value scores are estimates from the photo plus built-in wine knowledge. Always confirm the exact wine and price with the menu or staff.
          </p>
          <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-mute">
            We anonymously save wine names and list prices (we don&apos;t store your photo or any personal details) to build a market price guide.
          </p>
        </footer>
      </main>
    </div>
  );
}
