// Tiny analytics wrapper. No-op until NEXT_PUBLIC_GA4_ID is set in Vercel env.
// Usage: track("scan_started", { wine_count: 12 })

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    __gaQueue?: { name: string; params?: Record<string, unknown> }[];
  }
}

export function track(name: string, params?: Record<string, unknown>) {
  try {
    if (typeof window === "undefined") return;
    if (window.gtag) {
      window.gtag("event", name, params ?? {});
    } else {
      window.__gaQueue = window.__gaQueue ?? [];
      window.__gaQueue.push({ name, params });
      if (process.env.NODE_ENV === "development") console.debug("[analytics]", name, params);
    }
  } catch {
    /* never break UX for analytics */
  }
}

export function flushQueue() {
  try {
    if (typeof window === "undefined" || !window.gtag || !window.__gaQueue) return;
    for (const e of window.__gaQueue) window.gtag("event", e.name, e.params ?? {});
    window.__gaQueue = [];
  } catch {
    /* ignore */
  }
}
