import type { Metadata, Viewport } from "next";

import { BRANDING } from "@/lib/branding";

import "./globals.css";

export const metadata: Metadata = {
  title: `${BRANDING.name} — ${BRANDING.tagline}`,
  description: BRANDING.description,
  manifest: "/manifest.webmanifest",
  // iOS ignores the manifest's icon list entirely and looks for this link.
  appleWebApp: { capable: true, title: BRANDING.shortName, statusBarStyle: "black-translucent" },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
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
