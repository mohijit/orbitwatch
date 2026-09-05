import type { MetadataRoute } from "next";

import { BRANDING } from "@/lib/branding";

/**
 * The installable app.
 *
 * A route rather than a static file in public/, so the product name comes from
 * BRANDING like everywhere else and a typo in a key is a type error rather than a
 * manifest a browser silently declines to install from.
 *
 * WHAT "INSTALLABLE" HONESTLY MEANS HERE
 * Installing does not make the catalog available. A first launch with no network has
 * nothing cached and says so; what the service worker holds is what this browser has
 * already loaded. The manifest is about the app being a first-class thing on a device,
 * not a promise about data.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${BRANDING.name} — ${BRANDING.tagline}`,
    short_name: BRANDING.shortName,
    description: BRANDING.description,
    start_url: "/",
    display: "standalone",
    background_color: "#070b14",
    theme_color: "#070b14",
    orientation: "any",
    categories: ["education", "navigation", "utilities"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      /*
       * Its own file, not the same one relabelled.
       *
       * Android crops a maskable icon to the launcher's shape and only the inner 80%
       * circle is guaranteed to survive. Declaring `purpose: "any maskable"` on the
       * standard icon passes every manifest checker and loses its edges on a real
       * phone, so the maskable variant is drawn smaller inside that safe zone.
       */
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
