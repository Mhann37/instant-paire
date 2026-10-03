// Menus aren't always in pounds. Prices are kept in the menu's currency for display; value
// scoring compares against UK retail (GBP), so we convert with rough static rates. These are
// deliberately approximate - they only feed a markup multiple, never a displayed conversion.

export type CurrencyCode = "GBP" | "EUR" | "USD" | "AUD" | "CAD" | "CHF";

export const CURRENCIES: Record<CurrencyCode, { symbol: string; gbpPerUnit: number }> = {
  GBP: { symbol: "£", gbpPerUnit: 1 },
  EUR: { symbol: "€", gbpPerUnit: 0.86 },
  USD: { symbol: "$", gbpPerUnit: 0.75 },
  AUD: { symbol: "A$", gbpPerUnit: 0.5 },
  CAD: { symbol: "C$", gbpPerUnit: 0.55 },
  CHF: { symbol: "CHF ", gbpPerUnit: 0.92 },
};

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

/** Accepts ISO codes or common symbols ("£", "€", "$"); falls back to GBP. */
export function parseCurrency(v: unknown): CurrencyCode {
  const s = String(v ?? "").trim().toUpperCase();
  if ((CURRENCY_CODES as string[]).includes(s)) return s as CurrencyCode;
  if (s === "£") return "GBP";
  if (s === "€") return "EUR";
  if (s === "$") return "USD";
  return "GBP";
}

export function toGBP(amount: number, currency: CurrencyCode): number {
  return amount * CURRENCIES[currency].gbpPerUnit;
}
