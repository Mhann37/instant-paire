import type { Metadata } from "next";
import "./globals.css";
import Analytics from "@/components/Analytics";

export const metadata: Metadata = {
  title: "Instant Paire — snap the list, eat well",
  description: "Photograph any wine list, say what you're eating, and get the best-suited and best-valued bottles with confidence scores.",
  metadataBase: new URL("https://instant-paire.vercel.app"),
  openGraph: {
    title: "Instant Paire",
    description: "Snap the list. Eat well. Best match + best value in seconds.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full flex flex-col bg-cream text-ink antialiased">
        <Analytics />
        {children}
      </body>
    </html>
  );
}
