"use client";

import { useMemo } from "react";

import type { SatellitePass, SkyTrackPoint } from "@orbitwatch/orbit-core";

/**
 * Polar plot of one pass: where to look, and when.
 *
 * A pass list gives you "max 47° NNE at 18:42", which is enough to point at but not
 * enough to follow. This is the shape of the pass — where it rises, the arc it takes,
 * where it disappears — drawn on the hemisphere of sky above the observer.
 *
 * PROJECTION
 * Zenith at the centre, horizon at the rim, radius linear in zenith angle:
 * r = (90 - elevation) / 90. Linear rather than stereographic on purpose. A
 * stereographic projection preserves the shape of constellations, which matters for a
 * star chart and not at all here; what matters is that "halfway to the middle" means
 * 45°, so someone can read an elevation off the picture without a scale.
 *
 * ORIENTATION IS A REAL CHOICE, AND IT IS STATED
 * North at the top, east at the RIGHT — the orientation of a compass or a map, held
 * flat. The alternative convention, used by star charts, mirrors east and west because
 * you are looking up at the sky rather than down at the ground. Both are defensible;
 * this one is chosen because the immediately preceding action is reading a bearing and
 * turning to face it, and because it will agree with the device compass. The chart
 * labels its own cardinal points, so a reader never has to guess which convention
 * is in force.
 *
 * SHADOW IS DRAWN, NOT AVERAGED
 * The arc is split by illumination state. A satellite crossing into Earth's umbra
 * mid-pass vanishes while still high in the sky, and a single uniform arc would be
 * drawing a pass that does not happen. The unlit portion is dashed and dim, and where
 * an entry point exists it is marked. This is the same reason `SkyTrackPoint` carries
 * illumination per sample rather than one value for the pass.
 */

export interface SkyChartProps {
  readonly pass: SatellitePass;
  readonly track: readonly SkyTrackPoint[];
}

/** Drawing size in user units. The SVG scales to its container via viewBox. */
const SIZE = 220;
const CENTRE = SIZE / 2;
/** Leaves room outside the horizon circle for the cardinal labels. */
const RADIUS = 88;

const ELEVATION_RINGS = [30, 60] as const;

const CARDINALS = [
  { label: "N", azimuth: 0 },
  { label: "E", azimuth: 90 },
  { label: "S", azimuth: 180 },
  { label: "W", azimuth: 270 },
] as const;

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Sky coordinates to chart coordinates.
 *
 * `sin` on x and `-cos` on y puts azimuth 0 at the top and 90 at the right, which is
 * the compass orientation described above. SVG's y axis grows downward, hence the
 * negation rather than a subtraction elsewhere.
 */
function project(azimuth: number, elevation: number): Point {
  const radius = ((90 - elevation) / 90) * RADIUS;
  const radians = (azimuth * Math.PI) / 180;
  return {
    x: CENTRE + radius * Math.sin(radians),
    y: CENTRE - radius * Math.cos(radians),
  };
}

function toPath(points: readonly Point[]): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
}

/** True when the spacecraft is reflecting sunlight and could actually be seen. */
function isLit(point: SkyTrackPoint): boolean {
  return point.illumination === "SUNLIT" || point.illumination === "PENUMBRA";
}

interface Segment {
  readonly lit: boolean;
  readonly points: readonly Point[];
}

/**
 * Split the track into runs of like illumination.
 *
 * Consecutive segments share their boundary sample, so the drawn arc has no gap at the
 * transition: the last point of the lit run is the first point of the unlit one.
 */
function segmentByIllumination(track: readonly SkyTrackPoint[]): readonly Segment[] {
  const segments: { lit: boolean; points: Point[] }[] = [];

  for (const sample of track) {
    const lit = isLit(sample);
    const point = project(sample.azimuth, sample.elevation);
    const current = segments.at(-1);

    if (current === undefined || current.lit !== lit) {
      // Carry the previous run's final point into the new one so the line is unbroken.
      const bridge = current?.points.at(-1);
      segments.push({ lit, points: bridge === undefined ? [point] : [bridge, point] });
    } else {
      current.points.push(point);
    }
  }

  return segments;
}

/** The first sample at which a lit satellite goes dark, if that happens mid-pass. */
function shadowEntry(track: readonly SkyTrackPoint[]): SkyTrackPoint | undefined {
  for (let index = 1; index < track.length; index += 1) {
    const previous = track[index - 1];
    const current = track[index];
    if (previous !== undefined && current !== undefined && isLit(previous) && !isLit(current)) {
      return current;
    }
  }
  return undefined;
}

export function SkyChart({ pass, track }: SkyChartProps) {
  const segments = useMemo(() => segmentByIllumination(track), [track]);
  const entry = useMemo(() => shadowEntry(track), [track]);

  if (track.length < 2) {
    return (
      <p className="sky-chart__empty" data-testid="sky-chart-empty">
        This pass could not be plotted: the elements do not propagate across it.
      </p>
    );
  }

  const rise = project(pass.aos.azimuth, pass.aos.elevation);
  const peak = project(pass.maximum.azimuth, pass.maximum.elevation);
  const set = project(pass.los.azimuth, pass.los.elevation);

  // Spoken form of the same information, for anyone who cannot see the plot. The
  // chart is a second presentation of data already in the list, so this describes the
  // path rather than restating the row above it.
  const description =
    `Sky path: rises ${pass.aos.compass} at ${timeFormat.format(pass.aos.time)}, ` +
    `peaks at ${Math.round(pass.maximum.elevation)} degrees ${pass.maximum.compass} at ` +
    `${timeFormat.format(pass.maximum.time)}, sets ${pass.los.compass} at ` +
    `${timeFormat.format(pass.los.time)}.` +
    (entry === undefined
      ? ""
      : ` Enters Earth's shadow at ${timeFormat.format(entry.time)}, ` +
        `${Math.round(entry.elevation)} degrees above the horizon.`);

  return (
    <figure className="sky-chart" data-testid="sky-chart">
      <svg
        viewBox={`0 0 ${String(SIZE)} ${String(SIZE)}`}
        className="sky-chart__svg"
        role="img"
        aria-label={description}
      >
        <circle
          cx={CENTRE}
          cy={CENTRE}
          r={RADIUS}
          className="sky-chart__horizon"
          data-testid="sky-chart-horizon"
        />

        {ELEVATION_RINGS.map((elevation) => (
          <g key={elevation}>
            <circle
              cx={CENTRE}
              cy={CENTRE}
              r={((90 - elevation) / 90) * RADIUS}
              className="sky-chart__ring"
            />
            {/* Labelled, because an unlabelled ring is decoration. */}
            <text
              x={CENTRE + 3}
              y={CENTRE - ((90 - elevation) / 90) * RADIUS - 2}
              className="sky-chart__ring-label"
            >
              {elevation}°
            </text>
          </g>
        ))}

        {CARDINALS.map(({ label, azimuth }) => {
          const at = project(azimuth, 0);
          // Pushed outward from the rim so the label never sits on the arc.
          const outward = {
            x: CENTRE + (at.x - CENTRE) * 1.14,
            y: CENTRE + (at.y - CENTRE) * 1.14,
          };
          return (
            <text
              key={label}
              x={outward.x}
              y={outward.y}
              className="sky-chart__cardinal"
              dominantBaseline="middle"
              textAnchor="middle"
            >
              {label}
            </text>
          );
        })}

        {segments.map((segment, index) => (
          <path
            key={index}
            d={toPath(segment.points)}
            className={`sky-chart__arc sky-chart__arc--${segment.lit ? "lit" : "shadow"}`}
            data-testid={segment.lit ? "sky-chart-arc-lit" : "sky-chart-arc-shadow"}
          />
        ))}

        <circle cx={rise.x} cy={rise.y} r={3} className="sky-chart__marker sky-chart__marker--aos" />
        <circle cx={set.x} cy={set.y} r={3} className="sky-chart__marker sky-chart__marker--los" />
        <circle
          cx={peak.x}
          cy={peak.y}
          r={4}
          className="sky-chart__marker sky-chart__marker--max"
          data-testid="sky-chart-max"
        />

        {entry === undefined ? null : (
          <circle
            cx={project(entry.azimuth, entry.elevation).x}
            cy={project(entry.azimuth, entry.elevation).y}
            r={3.5}
            className="sky-chart__marker sky-chart__marker--shadow"
            data-testid="sky-chart-shadow-entry"
          />
        )}
      </svg>

      <figcaption className="sky-chart__caption">
        <span className="sky-chart__legend">
          <span className="sky-chart__key sky-chart__key--lit" /> sunlit
          {entry === undefined ? null : (
            <>
              <span className="sky-chart__key sky-chart__key--shadow" /> in shadow from{" "}
              {timeFormat.format(entry.time)}
            </>
          )}
        </span>
        <span className="sky-chart__orientation">
          North up, east right — compass orientation, held flat. Elevations are
          geometric: no terrain, buildings or refraction.
        </span>
      </figcaption>
    </figure>
  );
}
