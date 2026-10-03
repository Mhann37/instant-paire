"use client";

import { useEffect } from "react";
import { flushQueue } from "@/lib/analytics";

export default function Analytics() {
  const gaId = process.env.NEXT_PUBLIC_GA4_ID;
  useEffect(() => {
    if (!gaId) return;
    if (document.querySelector(`script[data-ga4="${gaId}"]`)) return;
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${gaId}`;
    s.dataset.ga4 = gaId;
    document.head.appendChild(s);
    const inline = document.createElement("script");
    inline.innerHTML = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${gaId}',{anonymize_ip:true});`;
    document.head.appendChild(inline);
    const t = setTimeout(flushQueue, 1500);
    return () => clearTimeout(t);
  }, [gaId]);
  return null;
}
