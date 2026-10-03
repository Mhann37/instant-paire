// Client-side OCR text -> structured wine candidates.
// Tesseract is noisy on wine lists (columns, glare, italics) so we keep this
// conservative: split lines, attach prices, drop obvious non-wine lines.

export function parseOcrText(text: string, avgConfidence: number): import("./types").WineCandidate[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 3);

  const out: import("./types").WineCandidate[] = [];
  let n = 0;

  for (const line of lines) {
    // Skip headers / sections
    if (/^(white|red|ros|sparkling|champagne|dessert|wine list|menu|by the glass|bottle)\b/i.test(line) && line.length < 30 && !/\d/.test(line)) continue;
    if (line.length < 6) continue;

    // Extract trailing price: 45, £45, 45.00, $45
    const priceMatch = line.match(/(£|\$|€)?\s?(\d{2,4}(?:\.\d{2})?)\s*$/) ;
    let listPrice: number | undefined;
    let name = line;
    if (priceMatch) {
      const v = parseFloat(priceMatch[2]);
      if (v >= 8 && v <= 5000) {
        listPrice = v;
        name = line.slice(0, priceMatch.index).trim().replace(/[·•\-–—|]+$/, "").trim();
      }
    }

    // Must look vaguely like a wine (letters + min length). Keep price-less lines too —
    // user can edit, and rank API handles missing price.
    if (name.replace(/[^a-z]/gi, "").length < 6) continue;
    // Drop obvious food lines
    if (/\b(chicken|steak|burger|pizza|pasta|salad|chips|fries)\b/i.test(name) && !/\b(pinot|chardonnay|rioja|bordeaux|malbec|shiraz|sauvignon|merlot|cabernet|barolo|chianti|prosecco|chablis|sancerre)\b/i.test(name)) continue;

    const vintageMatch = name.match(/\b(19\d{2}|20[0-2]\d)\b/);
    n += 1;
    const ocrConfidence = Math.max(0.3, Math.min(0.99, avgConfidence - (listPrice ? 0 : 0.12)));
    out.push({
      id: `w${n}`,
      rawName: name.slice(0, 120),
      vintage: vintageMatch?.[1],
      listPrice,
      ocrConfidence: Math.round(ocrConfidence * 100) / 100,
      needsReview: ocrConfidence < 0.6 || !listPrice,
    });
    if (out.length >= 40) break;
  }

  return out;
}

export function avgWordConfidence(words: { confidence: number }[]): number {
  if (!words.length) return 0.5;
  const vals = words.map((w) => (w.confidence > 1 ? w.confidence / 100 : w.confidence));
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
