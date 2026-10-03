"use client";

import { useMemo, useRef, useState } from "react";
import { parseOcrText } from "@/lib/ocr-parse";
import type { RankedWine, RankResponse, WineCandidate } from "@/lib/types";
import { track } from "@/lib/analytics";
import { getEntitlement, recordScan } from "@/lib/entitlements";

type Step = "input" | "reading" | "review" | "ranking" | "results";

export default function Home() {
  const [dish, setDish] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [wines, setWines] = useState<WineCandidate[]>([]);
  const [ranked, setRanked] = useState<RankedWine[]>([]);
  const [meta, setMeta] = useState<RankResponse["meta"] | null>(null);
  const [step, setStep] = useState<Step>("input");
  const [error, setError] = useState<string | null>(null);
  const [scansLeft, setScansLeft] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const canAnalyse = useMemo(() => dish.trim().length > 1 && (wines.length > 0 || imageUrl), [dish, wines, imageUrl]);

  async function onFile(f: File | undefined) {
    if (!f) return;
    setError(null);
    const url = URL.createObjectURL(f);
    setImageUrl(url);
    setStep("reading");
    track("scan_started", { has_dish: Boolean(dish.trim()) });
    try {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng");
      const { data } = await worker.recognize(f);
      await worker.terminate();
      const avg = typeof data.confidence === "number" ? data.confidence / 100 : 0.7;
      const parsed = parseOcrText(data.text ?? "", avg);
      setWines(parsed);
      track("ocr_completed", { wine_count: parsed.length, ocr_confidence_avg: avg });
      setStep("review");
      if (!parsed.length) setError("Couldn't read any wines - try a straighter, well-lit photo, or add them manually below.");
    } catch {
      setError("Photo reading failed on-device. Add wines manually below, then Analyse.");
      setStep("review");
    }
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
      const res = await fetch("/api/rank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dish: dish.trim(), wines: clean }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Ranking failed");
      setRanked((data as RankResponse).ranked);
      setMeta((data as RankResponse).meta);
      recordScan();
      setScansLeft(getEntitlement().scansLeft);
      setStep("results");
      track("rank_viewed", { top_score: (data as RankResponse).ranked[0]?.finalScore ?? 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ranking failed - try again.");
      setStep("review");
    }
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

          <div className="mt-5">
            <p className="text-sm font-medium">Wine list photo</p>
            <div
              onClick={() => fileRef.current?.click()}
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
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            {imageUrl && (
              <button onClick={() => fileRef.current?.click()} className="mt-2 text-xs font-medium underline underline-offset-4">
                Retake photo
              </button>
            )}
          </div>

          {step === "reading" && (
            <div className="mt-4">
              <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-neutral-900" />
              </div>
              <p className="mt-2 text-xs text-neutral-500">Reading list on your device…</p>
            </div>
          )}

          {error && <p className="mt-4 rounded-2xl bg-neutral-900 px-4 py-3 text-sm text-white">{error}</p>}

          {(step === "review" || step === "ranking" || step === "results") && (
            <div className="mt-5">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Wines found ({wines.length}) — tap to fix</p>
                <button onClick={addManual} className="text-xs font-medium underline underline-offset-4">+ Add manually</button>
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
                      value={w.listPrice ?? ""}
                      onChange={(e) => updateWine(w.id, { listPrice: e.target.value ? Number(e.target.value) : undefined })}
                      placeholder="£"
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
                <RankCard key={w.id} wine={w} featured />
              ))}
            </div>
            {rest.length > 0 && (
              <>
                <h2 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-widest text-neutral-400">Rest of the list</h2>
                <div className="grid gap-2">
                  {rest.map((w) => (
                    <RankCard key={w.id} wine={w} />
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
        </footer>
      </main>
    </div>
  );
}

function RankCard({ wine, featured }: { wine: RankedWine; featured?: boolean }) {
  const bandColor = wine.confidenceBand === "High" ? "bg-neutral-900 text-white" : wine.confidenceBand === "Medium" ? "bg-neutral-200 text-neutral-800" : "bg-neutral-100 text-neutral-500";
  return (
    <article className={`rounded-3xl border p-5 ${featured ? "border-neutral-900" : "border-neutral-200"} bg-white`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          {wine.role && <span className={`mb-1.5 inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${featured ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-700"}`}>{wine.role}</span>}
          <h3 className="text-lg font-semibold leading-snug tracking-tight">{wine.rawName || "Unnamed wine"}</h3>
          <p className="mt-0.5 text-xs text-neutral-500">
            {wine.listPrice ? `£${wine.listPrice} on list` : "Price not read"}{wine.typicalRetailGBP ? ` · ~£${wine.typicalRetailGBP} retail est.` : ""} · {wine.style}
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
    </article>
  );
}
