import type { EnrichedWine, WineCandidate } from "./types";

// Heuristic enrichment so v1 works with zero API keys.
// If OPENAI_API_KEY is set, /api/rank upgrades these via a single batched LLM call.

const RED = ["pinot noir", "bordeaux", "cabernet", "merlot", "malbec", "shiraz", "syrah", "rioja", "barolo", "chianti", "tempranillo", "grenache", "nebbiolo", "zinfandel", "beaujolais"];
const WHITE = ["chardonnay", "sauvignon", "chablis", "sancerre", "riesling", "pinot grigio", "pinot gris", "albariño", "albarino", "viognier", "chenin", "gavi", "vermentino"];
const SPARK = ["champagne", "prosecco", "cava", "crémant", "cremant", "pét-nat", "pet-nat", "english sparkling"];
const ROSE = ["rosé", "rose", "provence"];

export function heuristicEnrich(wines: WineCandidate[]): EnrichedWine[] {
  return wines.map((w) => {
    const n = w.rawName.toLowerCase();
    let category: EnrichedWine["category"] = "unknown";
    if (SPARK.some((k) => n.includes(k))) category = "sparkling";
    else if (ROSE.some((k) => n.includes(k))) category = "rose";
    else if (RED.some((k) => n.includes(k))) category = "red";
    else if (WHITE.some((k) => n.includes(k))) category = "white";
    else if (/moscato|sauternes|port|sherry/.test(n)) category = "dessert";

    // Body / tannin / acidity guesses by grape family
    let body = 1, tannin = category === "red" ? 1 : 0, acidity = 1;
    if (/barolo|nebbiolo|cabernet|malbec|shiraz|syrah/.test(n)) { body = 2; tannin = 2; acidity = 1; }
    if (/pinot noir|beaujolais|rioja|chianti|tempranillo/.test(n)) { body = 1; tannin = 1; acidity = 1.4; }
    if (/chardonnay|viognier/.test(n)) { body = 1.6; acidity = 0.8; }
    if (/sauvignon|sancerre|chablis|riesling|albari/.test(n)) { body = 0.8; acidity = 1.8; }
    if (category === "sparkling") { body = 0.8; acidity = 1.8; tannin = 0; }
    if (category === "rose") { body = 0.8; acidity = 1.4; tannin = 0.2; }

    return {
      ...w,
      style: category === "unknown" ? "wine" : `${category}`,
      category, body, acidity, tannin,
      typicalRetailGBP: undefined, // unknown without LLM/lookup — value scored on relative price instead
      qualityTier: "unknown",
      grounded: false,
    };
  });
}

// Dish -> preferred profile. Simple, transparent, editable.
export function dishProfile(dish: string): { needsTannin: number; needsAcid: number; needsBody: number; keywords: string[] } {
  const d = dish.toLowerCase();
  const p = { needsTannin: 1, needsAcid: 1, needsBody: 1, keywords: [] as string[] };
  if (/steak|ribeye|lamb|venison|beef|burger|short rib|bbq|barbecue/.test(d)) { p.needsTannin = 2; p.needsBody = 2; p.needsAcid = 0.8; }
  if (/salmon|tuna|sea bass|sole|cod|fish|oyster|mussel|prawn|scallop|sushi/.test(d)) { p.needsAcid = 2; p.needsBody = 0.7; p.needsTannin = 0; }
  if (/roast chicken|turkey|pork|veal/.test(d)) { p.needsAcid = 1.4; p.needsBody = 1.2; p.needsTannin = 0.6; }
  if (/pasta|pizza|tomato|ragu|lasagne|lasagna/.test(d)) { p.needsAcid = 1.8; p.needsBody = 1.2; p.needsTannin = 0.8; }
  if (/curry|thai|spicy|szechuan|kimchi|taco/.test(d)) { p.needsAcid = 1.6; p.needsBody = 0.8; p.needsTannin = 0; }
  if (/cheese|charcuterie|mushroom|truffle/.test(d)) { p.needsBody = 1.5; p.needsTannin = 1.2; }
  if (/salad|goat|vegan|vegetable|asparagus/.test(d)) { p.needsAcid = 1.8; p.needsBody = 0.6; p.needsTannin = 0; }
  if (/chocolate|dessert|cake/.test(d)) { p.needsBody = 1.5; p.needsAcid = 1; }
  return p;
}
