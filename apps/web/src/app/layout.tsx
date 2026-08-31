import type { Metadata, Viewport } from "next";

import { BRANDING } from "@/lib/branding";

import "./globals.css";

export const metadata: Metadata = {
  title: `${BRANDING.name} — ${BRANDING.tagline}`,
  description: BRANDING.description,
};

export const viewport: Viewport = {
  themeColor: "#070b14",
  // The globe is full-bleed; the app must extend under device notches.
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* The dark shell paints immediately, so the user never sees a white flash
          while the Cesium engine loads. */}
      <body>{children}</body>
    </html>
  );
}
