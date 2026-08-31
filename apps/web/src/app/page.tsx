import { GlobeView } from "@/components/globe/globe-view";
import { BRANDING } from "@/lib/branding";

/**
 * Milestone 0 shell: brand chrome plus the Cesium proof of concept.
 *
 * The status strip deliberately shows no counts or timestamps yet. Displaying
 * "16,000 objects" before the catalog exists would be exactly the fabricated-data
 * problem this project is built to avoid.
 */
export default function HomePage() {
  return (
    <main className="shell">
      <header className="shell__bar">
        <span className="shell__brand">{BRANDING.name}</span>
        <span className="shell__badge">MILESTONE 0 · RENDERER PROOF OF CONCEPT</span>
      </header>

      <GlobeView />

      <footer className="shell__note">
        Positions in this product are calculated from published orbital elements using
        SGP4/SDP4. They are not continuous onboard GPS telemetry.
      </footer>
    </main>
  );
}
