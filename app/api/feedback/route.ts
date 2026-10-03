import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/guard";
import { pushCapped } from "@/lib/store";
import { normalise, wineKey } from "@/lib/wine-key";

export const runtime = "nodejs";

// Outcome data: "I ordered this with that dish - did it work?". Anonymous (no device id stored).
// Today it's only collected; once there's volume it calibrates pairing scores per wine + dish.

const CATEGORIES = ["red", "white", "rose", "sparkling", "dessert", "unknown"];

export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, "feedback", 60, 600);
  if (limited) return limited;

  let b: { name?: unknown; vintage?: unknown; category?: unknown; dish?: unknown; rating?: unknown };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 120) : "";
  const rating = b.rating === 1 || b.rating === -1 ? b.rating : 0;
  if (!name || !rating) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const vintage = typeof b.vintage === "string" && /^(19|20)\d{2}$/.test(b.vintage) ? b.vintage : undefined;
  const category = CATEGORIES.includes(b.category as string) ? (b.category as string) : "unknown";
  const dish = typeof b.dish === "string" ? normalise(b.dish).slice(0, 60) : "";

  await pushCapped(
    `fb:${wineKey(name, vintage)}`,
    JSON.stringify({ r: rating, c: category, d: dish, day: Math.floor(Date.now() / 86_400_000) }),
    200,
    60 * 60 * 24 * 730,
  );
  return NextResponse.json({ ok: true });
}
