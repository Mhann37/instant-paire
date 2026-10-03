"use client";

import type { RankedWine } from "@/lib/types";
import { CURRENCIES, type CurrencyCode } from "@/lib/currency";

const CATEGORY_COLOR: Record<RankedWine["category"], string> = {
  red: "#8b1e3f",
  white: "#e8d28a",
  rose: "#e58fa3",
  sparkling: "#d8c27a",
  dessert: "#c77d1a",
  unknown: "#b8afa5",
};

const CATEGORY_LABEL: Record<RankedWine["category"], string> = {
  red: "Red",
  white: "White",
  rose: "Rosé",
  sparkling: "Sparkling",
  dessert: "Dessert",
  unknown: "Wine",
};

const ROLE_STYLE = {
  "Best Match": { icon: "★", badge: "bg-[#f0d48a] text-claret-deep", ring: "#f0d48a" },
  "Best Value": { icon: "◆", badge: "bg-[#d4eee3] text-[#14573f]", ring: "var(--green)" },
  Wildcard: { icon: "✦", badge: "bg-[#e6def5] text-[#4b3380]", ring: "var(--violet)" },
} as const;

export function CategoryDot({ category }: { category: RankedWine["category"] }) {
  return <i className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: CATEGORY_COLOR[category] }} aria-hidden />;
}

function ScoreRing({ score, color, onDark }: { score: number; color: string; onDark?: boolean }) {
  const track = onDark ? "rgba(255,255,255,.18)" : "#efe6da";
  return (
    <div
      className="grid h-[58px] w-[58px] shrink-0 place-items-center rounded-full"
      style={{ background: `conic-gradient(${color} ${Math.max(0, Math.min(100, score))}%, ${track} 0)` }}
      role="img"
      aria-label={`Score ${score} out of 100`}
    >
      <span className={`grid h-[46px] w-[46px] place-items-center rounded-full text-[17px] font-bold tabular-nums ${onDark ? "bg-claret-deep text-white" : "bg-white text-ink"}`}>{score}</span>
    </div>
  );
}

function Meter({ label, value, text, onDark }: { label: string; value: number; text: string; onDark?: boolean }) {
  return (
    <div className="flex-1">
      <div className={`flex justify-between text-[11px] ${onDark ? "text-[#e9cbd5]" : "text-mute"}`}>
        <span>{label}</span>
        <b className="tabular-nums">{text}</b>
      </div>
      <div className={`mt-1 h-1.5 overflow-hidden rounded-full ${onDark ? "bg-white/20" : "bg-[#efe6da]"}`}>
        <div className="h-full rounded-full" style={{ width: `${Math.max(4, Math.min(100, value * 100))}%`, background: onDark ? "var(--gold-soft)" : "var(--green)" }} />
      </div>
    </div>
  );
}

function MarketChip({ wine, onDark }: { wine: RankedWine; onDark?: boolean }) {
  const m = wine.market;
  if (!m) return null;
  const cheap = m.deltaPct <= -8;
  const dear = m.deltaPct >= 8;
  const tone = cheap
    ? onDark ? "bg-white/15 text-[#bfebd6]" : "bg-[#d4eee3] text-[#14573f]"
    : dear
      ? "bg-[#fbe3d6] text-[#8a3a12]"
      : onDark ? "bg-white/10 text-[#e9cbd5]" : "bg-[#f1ebe3] text-mute";
  const text = cheap
    ? `▼ ${Math.abs(m.deltaPct)}% below typical menu price`
    : dear
      ? `▲ ${m.deltaPct}% above typical menu price`
      : "In line with typical menu price";
  return (
    <div className="mt-3">
      <span className={`inline-block rounded-[10px] px-2.5 py-1 text-xs font-semibold ${tone}`}>{text}</span>
      <p className={`mt-1 text-[11px] ${onDark ? "text-[#e9cbd5]" : "text-mute"}`}>
        Typically £{m.medianGBP} on menus (£{m.minGBP}–£{m.maxGBP}) · {m.n} lists
      </p>
    </div>
  );
}

const bandTone = (band: RankedWine["confidenceBand"], onDark?: boolean) =>
  band === "High"
    ? onDark ? "bg-white/20 text-white" : "bg-[#d4eee3] text-[#14573f]"
    : band === "Medium"
      ? onDark ? "bg-white/12 text-[#e9cbd5]" : "bg-[#f6e6be] text-[#7a5410]"
      : onDark ? "bg-white/10 text-[#e9cbd5]" : "bg-[#efe9e2] text-mute";

export function RankCard({
  wine, index, currency, rated, onRate,
}: {
  wine: RankedWine;
  index: number;
  currency: CurrencyCode;
  rated?: 1 | -1;
  onRate: (w: RankedWine, r: 1 | -1) => void;
}) {
  const sym = CURRENCIES[currency].symbol;
  const role = wine.role ? ROLE_STYLE[wine.role] : undefined;
  const hero = wine.role === "Best Match";
  const flags = wine.flags.filter((f) => !/typical list price/.test(f));

  return (
    <article
      className={`rise relative overflow-hidden rounded-[22px] p-4 ${
        hero ? "bg-gradient-to-br from-claret to-claret-deep text-white shadow-[0_10px_30px_-12px_rgba(122,31,61,.6)]" : "border border-line bg-white"
      }`}
      style={{ ["--i" as string]: index }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {role && wine.role && (
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider ${role.badge}`}>
              <span aria-hidden>{role.icon}</span> {wine.role}
            </span>
          )}
          <h3 className="mt-2 text-lg font-semibold leading-snug tracking-tight">{wine.rawName || "Unnamed wine"}</h3>
          <p className={`mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px] ${hero ? "text-[#e9cbd5]" : "text-mute"}`}>
            <CategoryDot category={wine.category} />
            <span>{CATEGORY_LABEL[wine.category]}{wine.style && wine.style !== wine.category && wine.style !== "wine" ? ` · ${wine.style}` : ""}</span>
            <span>· {wine.listPrice ? `${sym}${wine.listPrice} on list` : "Price not read"}</span>
            {wine.typicalRetailGBP ? <span>· ~£{wine.typicalRetailGBP} retail</span> : null}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <ScoreRing score={wine.finalScore} color={role?.ring ?? "var(--gold)"} onDark={hero} />
          <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium tabular-nums ${bandTone(wine.confidenceBand, hero)}`}>
            {Math.round(wine.confidence * 100)}% · {wine.confidenceBand}
          </span>
        </div>
      </div>

      <p className={`mt-3 text-sm leading-relaxed ${hero ? "text-[#f6e3ea]" : "text-[#4a3a3f]"}`}>{wine.why}</p>

      <div className="mt-3 flex gap-3">
        <Meter label="Pairing" value={wine.pairingFit / 2} text={`${wine.pairingFit.toFixed(1)}/2`} onDark={hero} />
        <Meter label="Value" value={wine.valueScore} text={`${Math.round(wine.valueScore * 100)}%`} onDark={hero} />
      </div>

      <MarketChip wine={wine} onDark={hero} />

      {flags.length > 0 && <p className={`mt-2.5 text-xs ${hero ? "text-[#d9aebb]" : "text-mute"}`}>{flags.join(" · ")}</p>}

      <div className={`mt-3 flex items-center gap-2 text-xs ${hero ? "text-[#e9cbd5]" : "text-mute"}`}>
        {rated ? (
          <span>Thanks - your taste profile is updated.</span>
        ) : (
          <>
            <span>Ordered it?</span>
            {([[1, "Loved it"], [-1, "Not for me"]] as const).map(([r, label]) => (
              <button
                key={r}
                onClick={() => onRate(wine, r)}
                className={`rounded-full border px-2.5 py-1 font-semibold transition ${hero ? "border-white/25 bg-white/10 text-white hover:bg-white/20" : "border-line bg-white text-ink hover:border-claret"}`}
              >
                {label}
              </button>
            ))}
          </>
        )}
      </div>
    </article>
  );
}

export function MiniRow({ wine, index, currency }: { wine: RankedWine; index: number; currency: CurrencyCode }) {
  const sym = CURRENCIES[currency].symbol;
  const flags = wine.flags.filter((f) => !/typical list price|Judged live|Style inferred/.test(f));
  return (
    <div className="rise flex items-center gap-3 rounded-[18px] border border-line bg-white px-3.5 py-3" style={{ ["--i" as string]: index }}>
      <CategoryDot category={wine.category} />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{wine.rawName}</p>
        <p className="truncate text-xs text-mute">
          {wine.listPrice ? `${sym}${wine.listPrice}` : "Price not read"}
          {wine.market && Math.abs(wine.market.deltaPct) >= 8 ? ` · ${wine.market.deltaPct < 0 ? "▼" : "▲"} ${Math.abs(wine.market.deltaPct)}% vs typical` : ""}
          {flags[0] ? ` · ${flags[0]}` : ""}
        </p>
      </div>
      <span className={`ml-auto text-[17px] font-bold tabular-nums ${wine.finalScore >= 70 ? "text-gold" : "text-mute"}`}>{wine.finalScore}</span>
    </div>
  );
}
