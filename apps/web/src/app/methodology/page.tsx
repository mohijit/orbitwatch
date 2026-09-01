import Link from "next/link";

/**
 * The published visibility methodology.
 *
 * M4 requires the visibility classification to be published, not merely applied. This
 * is that page: every rule the app uses to decide whether a pass can be seen, the
 * numbers behind each one, and — the part most trackers omit — what the method cannot
 * do. A classification a user cannot audit is a claim they have to take on trust, and
 * this product's whole premise is not asking for that.
 *
 * Statically rendered: it depends on nothing but its own text.
 */

export const metadata = {
  title: "Visibility methodology — OrbitWatch",
  description:
    "How OrbitWatch decides whether a satellite pass can be seen, and what it deliberately does not claim.",
};

export default function MethodologyPage() {
  return (
    <main className="prose-page">
      <p className="prose-page__back">
        <Link href="/">← Back to the globe</Link>
      </p>

      <h1>Visibility methodology</h1>

      <p className="prose-page__lead">
        Every visibility label in OrbitWatch comes from the rules below. They are
        deliberately simple and deliberately conservative, and the section on what this
        method <em>cannot</em> tell you is as important as the rest.
      </p>

      <h2>The rule</h2>
      <p>
        A satellite is visible to the naked eye when it is lit by the Sun while the
        observer is in darkness. It shines by reflected sunlight, so it must be
        illuminated; and the sky must be dark enough for that reflection to stand out.
        In practice this makes the hours after dusk and before dawn the only useful
        ones — in the middle of the night, satellites in low orbit are inside Earth&rsquo;s
        shadow.
      </p>

      <p>Each pass is classified as one of:</p>

      <dl className="prose-page__terms">
        <dt>Likely visible</dt>
        <dd>
          The spacecraft is in full sunlight, the observer&rsquo;s sky is below civil
          twilight, and the pass reaches at least 30° above the horizon.
        </dd>

        <dt>Possibly visible</dt>
        <dd>
          The spacecraft is lit — fully or in penumbra — and the sky is dark, but the
          pass stays low or the object is entering shadow. Worth looking for; easy to
          miss.
        </dd>

        <dt>Daylight</dt>
        <dd>
          The Sun is higher than 6° below the observer&rsquo;s horizon. Only a handful of
          exceptionally bright objects are visible in these conditions, so no pass is
          reported as visible however good its geometry.
        </dd>

        <dt>Satellite in shadow</dt>
        <dd>
          The object is inside Earth&rsquo;s umbra and reflects no sunlight, however dark
          the sky is.
        </dd>

        <dt>Not optically favourable</dt>
        <dd>Anything else — the conditions do not meet the rule above.</dd>
      </dl>

      <h2>The numbers</h2>
      <table className="prose-page__table">
        <thead>
          <tr>
            <th>Quantity</th>
            <th>Value</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Minimum elevation for a pass</td>
            <td>10°</td>
            <td>
              Below this, terrain, buildings and atmospheric extinction make a pass
              largely academic.
            </td>
          </tr>
          <tr>
            <td>Minimum elevation for “likely visible”</td>
            <td>30°</td>
            <td>
              Low passes sit in haze near the horizon and are usually blocked by
              something.
            </td>
          </tr>
          <tr>
            <td>Civil twilight</td>
            <td>Sun 6° below the horizon</td>
            <td>
              The point at which the brighter satellites begin to stand out against the
              sky.
            </td>
          </tr>
          <tr>
            <td>Astronomical twilight</td>
            <td>Sun 18° below the horizon</td>
            <td>Full darkness; fainter objects become reachable.</td>
          </tr>
          <tr>
            <td>Search window</td>
            <td>Dusk to dawn</td>
            <td>
              “Tonight” is the next period below civil twilight, not the next 24 hours.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Which objects are searched</h2>
      <p>
        <strong>Visible tonight</strong> searches CelesTrak&rsquo;s <code>visual</code>{" "}
        group — a curated list of roughly 150 objects bright enough to look for with the
        naked eye — and not the full catalogue of more than 16,000.
      </p>
      <p>
        This is a real restriction, and it exists because the orbital elements
        OrbitWatch ingests contain <em>no information about brightness at all</em>: no
        size, no albedo, no shape, no attitude. Applying the lighting rule to the whole
        catalogue is perfectly possible, and produces roughly 3,600 “optically
        favourable” passes over a single location in a single night — nearly all of them
        Starlink satellites and spent rocket debris that nobody could pick out of the
        sky. A list like that looks authoritative and is useless. Group membership is
        the only published statement about which objects can actually be seen, so it is
        what we use.
      </p>

      <h2>Reading the sky chart</h2>
      <p>
        Expanding a pass draws it on the hemisphere of sky above you. The centre is
        the zenith, straight overhead; the rim is the horizon; and the radius is linear
        in angle, so a point halfway to the centre is 45° up. The rings are drawn at
        30° and 60°.
      </p>
      <p>
        <strong>North is at the top and east is at the right</strong> — the orientation
        of a compass held flat. Star charts use the opposite convention, mirroring east
        and west, because they depict the sky as seen looking up rather than the ground
        as seen looking down. Both are correct; this one is chosen because the action
        that follows reading the chart is turning to face a bearing. The chart labels
        its cardinal points so the convention never has to be guessed.
      </p>
      <p>
        The arc is drawn solid where the spacecraft is sunlit and dashed where it is in
        Earth&rsquo;s shadow, with the crossing point marked. This matters more than it
        sounds: a satellite entering the umbra partway across simply disappears while
        still high in the sky, and a chart drawing one unbroken arc would be showing a
        pass that does not happen.
      </p>

      <h2>What this method does not tell you</h2>
      <ul className="prose-page__caveats">
        <li>
          <strong>No predicted brightness.</strong> OrbitWatch does not quote a
          magnitude. Doing so needs a per-object model of size, shape, surface and
          orientation that public catalogues do not publish; a number derived from
          orbital elements alone would be invented precision.
        </li>
        <li>
          <strong>No weather.</strong> Cloud, haze and light pollution are not modelled.
          A “likely visible” pass under overcast is not visible.
        </li>
        <li>
          <strong>No local horizon.</strong> Elevations are geometric, measured from an
          ideal flat horizon. Hills, buildings and trees are not accounted for, and
          atmospheric refraction — which lifts objects near the horizon slightly — is
          not modelled either.
        </li>
        <li>
          <strong>No flares.</strong> Brief specular glints from flat surfaces can make
          an otherwise invisible object momentarily obvious. They depend on attitude
          data we do not have.
        </li>
        <li>
          <strong>Predictions degrade with element age.</strong> Positions come from
          SGP4/SDP4 propagation of published elements, and accuracy falls as the
          elements age. Every panel in the app states the age of the element set it
          used; a pass computed from three-day-old low-orbit elements can be out by
          enough to matter.
        </li>
      </ul>

      <h2>Sources</h2>
      <p>
        Orbital elements and the <code>visual</code> group are courtesy of{" "}
        <a href="https://celestrak.org" rel="noreferrer noopener" target="_blank">
          CelesTrak
        </a>
        . Propagation uses SGP4/SDP4 as specified in Spacetrack Report #3 and its 2006
        revision. Solar position and illumination are computed locally; nothing on this
        page depends on a third-party visibility service.
      </p>
    </main>
  );
}
