// Monetisation seam. v1: generous free tier stored locally, no auth.
// Later: plug Clerk + Stripe here without touching UI — just replace the bodies
// and gate `canSeeFullList` / `canScan`.

import { FREE_SCANS_LIFETIME } from "./limits";

export type Entitlement = {
  allowed: boolean;
  scansUsed: number;
  scansLeft: number;
  plan: "free" | "pro";
  paywallReason?: string;
};

export function getEntitlement(): Entitlement {
  try {
    const used = Number(localStorage.getItem("wl_scans_used") ?? "0") || 0;
    const plan = (localStorage.getItem("wl_plan") as "free" | "pro") ?? "free";
    if (plan === "pro") return { allowed: true, scansUsed: used, scansLeft: Infinity, plan };
    return {
      allowed: used < FREE_SCANS_LIFETIME,
      scansUsed: used,
      scansLeft: Math.max(0, FREE_SCANS_LIFETIME - used),
      plan,
      paywallReason: used >= FREE_SCANS_LIFETIME ? "Free scan limit reached" : undefined,
    };
  } catch {
    return { allowed: true, scansUsed: 0, scansLeft: FREE_SCANS_LIFETIME, plan: "free" };
  }
}

export function recordScan() {
  try {
    const used = Number(localStorage.getItem("wl_scans_used") ?? "0") || 0;
    localStorage.setItem("wl_scans_used", String(used + 1));
  } catch {
    /* ignore */
  }
}

// --- Future Stripe stubs (do not call yet) ---
// export async function checkoutPro() { /* POST /api/billing/checkout */ }
// export async function openPortal() { /* POST /api/billing/portal */ }
