import { NextResponse } from "next/server";

// Monetisation stubs. Wire Stripe here later; UI already gates via lib/entitlements.
// POST /api/billing/checkout -> Stripe Checkout session
// POST /api/billing/portal -> Stripe Customer Portal
export async function POST() {
  return NextResponse.json({ error: "Billing not enabled yet." }, { status: 501 });
}
