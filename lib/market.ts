import type { CurrencyCode } from "./currency";
import { toGBP } from "./currency";
import type { MarketInfo } from "./types";
import { pushCappedMany, rangeMany } from "./store";
import { normalise, wineKey } from "./wine-key";

// The price index: every successful scan contributes anonymous (wine, list price) observations.
// Across many menus that becomes "what does this bottle typically cost on a restaurant list" - data
// a general-purpose chatbot simply doesn't have. No user or device identifiers are stored with
// observations; the optional venue name is only used to count each restaurant once.

const OBS_PER_WINE = 60;
const OBS_TTL_SEC = 60 * 60 * 24 * 400;
export const MIN_MARKET_N = 3; // distinct menus required before we show a market comparison

type Obs = { gbp: number; venue: string; day: number };

const obsKey = (wineK: string) => `obs:${wineK}`;
const today = () => Math.floor(Date.now() / 86_400_000);

export async function recordObservations(
  wines: { rawName: string; vintage?: string; listPrice?: number }[],
  currency: CurrencyCode,
  venue?: string,
) {
  const v = venue ? normalise(venue).slice(0, 60) : "";
  const items = wines.flatMap((w) => {
    if (!w.listPrice) return [];
    const gbp = Math.round(toGBP(w.listPrice, currency) * 100) / 100;
    if (!(gbp >= 4 && gbp <= 4000)) return [];
    const o: Obs = { gbp, venue: v, day: today() };
    return [{ key: obsKey(wineKey(w.rawName, w.vintage)), value: JSON.stringify(o) }];
  });
  await pushCappedMany(items, OBS_PER_WINE, OBS_TTL_SEC);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export async function lookupMarket(wines: { rawName: string; vintage?: string }[]): Promise<Map<string, MarketInfo>> {
  const keys = [...new Set(wines.map((w) => wineKey(w.rawName, w.vintage)))];
  const out = new Map<string, MarketInfo>();
  try {
    const lists = await rangeMany(keys.map(obsKey), OBS_PER_WINE);
    keys.forEach((k, i) => {
      // Newest first; count each named venue once so one restaurant can't skew the median.
      const seenVenues = new Set<string>();
      const prices: number[] = [];
      for (const raw of lists[i] ?? []) {
        let o: Obs;
        try {
          o = JSON.parse(raw) as Obs;
        } catch {
          continue;
        }
        if (typeof o.gbp !== "number") continue;
        if (o.venue) {
          if (seenVenues.has(o.venue)) continue;
          seenVenues.add(o.venue);
        }
        prices.push(o.gbp);
      }
      if (prices.length >= MIN_MARKET_N) {
        out.set(k, {
          n: prices.length,
          medianGBP: Math.round(median(prices)),
          minGBP: Math.round(Math.min(...prices)),
          maxGBP: Math.round(Math.max(...prices)),
        });
      }
    });
  } catch (e) {
    console.error("market lookup failed", e);
  }
  return out;
}
