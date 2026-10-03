import { NextRequest, NextResponse } from "next/server";
import { incr } from "./store";

// Server-side abuse protection. The client's localStorage counter is only UX - anyone can clear
// it - so the API routes enforce (a) per-IP rate limits and (b) a per-device lifetime scan quota.
// The device id is an anonymous httpOnly cookie; clearing it resets the quota, which is why the
// per-IP daily caps exist as the backstop.

export const DEVICE_COOKIE = "ip_did";

export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

export function getDevice(req: NextRequest): { id: string; isNew: boolean } {
  const existing = req.cookies.get(DEVICE_COOKIE)?.value;
  if (existing && /^[0-9a-f-]{36}$/.test(existing)) return { id: existing, isNew: false };
  return { id: crypto.randomUUID(), isNew: true };
}

export function setDeviceCookie(res: NextResponse, id: string) {
  res.cookies.set(DEVICE_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
}

/** Fixed-window limiter. Returns a 429 response when over the limit, else null. */
export async function rateLimit(req: NextRequest, bucket: string, limit: number, windowSec: number): Promise<NextResponse | null> {
  const win = Math.floor(Date.now() / 1000 / windowSec);
  const n = await incr(`rl:${bucket}:${clientIp(req)}:${win}`, windowSec);
  if (n <= limit) return null;
  return NextResponse.json(
    { error: "Too many requests - give it a minute and try again." },
    { status: 429, headers: { "Retry-After": String(windowSec) } },
  );
}
