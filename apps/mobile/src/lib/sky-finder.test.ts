import { describe, expect, it } from "vitest";

import {
  bearingDelta,
  calibrationFrom,
  canAim,
  orientationFrom,
  sight,
  smoothBearing,
  smoothGravity,
  uncertaintyRadius,
  type CameraGeometry,
  type Calibration,
  type DeviceOrientation,
} from "./sky-finder";

/**
 * The AR finder's geometry and its honesty policy.
 *
 * The screen that draws this cannot be tested without a phone, a camera and a sky. The
 * part that decides WHERE to draw, and whether to draw at all, needs none of those, so
 * it is all in one pure module and all of it is exercised here.
 */

/** A phone-ish camera: wide horizontally, and this makes the arithmetic checkable. */
const CAMERA: CameraGeometry = { horizontalFov: 60, verticalFov: 60 };
const GOOD: Calibration = calibrationFrom(3, 90);

const facingNorth: DeviceOrientation = { heading: 0, pitch: 0, roll: 0 };

describe("bearingDelta", () => {
  it("takes the short way round the compass", () => {
    // The wrap is the whole reason this is a named function: 350 to 10 is twenty
    // degrees to the right, not three hundred and forty to the left.
    expect(bearingDelta(350, 10)).toBe(20);
    expect(bearingDelta(10, 350)).toBe(-20);
    expect(bearingDelta(0, 90)).toBe(90);
    expect(bearingDelta(90, 0)).toBe(-90);
  });

  it("is never more than half a turn in either direction", () => {
    for (const [from, to] of [
      [0, 180],
      [0, 181],
      [359, 179],
      [45, 225],
    ] as const) {
      expect(Math.abs(bearingDelta(from, to))).toBeLessThanOrEqual(180);
    }
  });
});

describe("sight", () => {
  it("puts a target dead ahead in the middle of the frame", () => {
    const result = sight({ azimuth: 0, elevation: 0 }, facingNorth, CAMERA, GOOD);

    expect(result.status).toBe("on-screen");
    if (result.status !== "on-screen") return;
    expect(result.x).toBeCloseTo(0, 6);
    expect(result.y).toBeCloseTo(0, 6);
    expect(result.separation).toBeCloseTo(0, 6);
  });

  it("puts a target at the edge of the field of view at the edge of the frame", () => {
    // Half of a 60 degree field is 30, so a target 30 degrees right lands at x = 1.
    const result = sight({ azimuth: 30, elevation: 0 }, facingNorth, CAMERA, GOOD);

    expect(result.status).toBe("on-screen");
    if (result.status !== "on-screen") return;
    expect(result.x).toBeCloseTo(1, 6);
    expect(result.y).toBeCloseTo(0, 6);
  });

  it("finds an overhead target that the naive projection would lose", () => {
    /*
     * THE TEST THIS MODULE EXISTS FOR.
     *
     * The phone is pointed straight up. The satellite is two degrees from the zenith,
     * so it is plainly in frame — and its azimuth differs from the phone's heading by a
     * full 180 degrees, because meridians converge overhead and azimuth stops meaning
     * very much up there.
     *
     * The usual shortcut — divide the azimuth difference by the field of view — gives
     * 180/30 = 6, six times off screen, for a satellite the user is looking directly
     * at. Overhead passes are the bright ones, so that failure lands precisely on the
     * passes people go outside for.
     */
    const overhead: DeviceOrientation = { heading: 0, pitch: 90, roll: 0 };
    const result = sight({ azimuth: 180, elevation: 88 }, overhead, CAMERA, GOOD);

    expect(result.status).toBe("on-screen");
    if (result.status !== "on-screen") return;
    expect(result.separation).toBeCloseTo(2, 4);
    expect(Math.hypot(result.x, result.y)).toBeLessThan(0.2);

    // And the naive calculation this is contrasted with really would have failed.
    expect(Math.abs(bearingDelta(overhead.heading, 180)) / (CAMERA.horizontalFov / 2)).toBeGreaterThan(1);
  });

  it("rotates the frame with the phone", () => {
    /*
     * Roll is not cosmetic. Nobody holds a phone level, and a marker that ignores roll
     * slides off the object it is labelling as soon as the phone tips.
     *
     * Rolling the phone clockwise turns the world anticlockwise on screen, so a target
     * sitting to the right moves to the bottom of the frame by the same amount.
     */
    const level = sight({ azimuth: 15, elevation: 0 }, facingNorth, CAMERA, GOOD);
    const rolled = sight({ azimuth: 15, elevation: 0 }, { ...facingNorth, roll: 90 }, CAMERA, GOOD);

    expect(level.status).toBe("on-screen");
    expect(rolled.status).toBe("on-screen");
    if (level.status !== "on-screen" || rolled.status !== "on-screen") return;

    expect(level.x).toBeGreaterThan(0.4);
    expect(level.y).toBeCloseTo(0, 6);

    expect(rolled.x).toBeCloseTo(0, 6);
    expect(rolled.y).toBeCloseTo(-level.x, 6);
  });

  it("says which way to turn when the target is out of frame", () => {
    const right = sight({ azimuth: 80, elevation: 0 }, facingNorth, CAMERA, GOOD);
    expect(right.status).toBe("off-screen");
    if (right.status !== "off-screen") return;
    expect(right.turn).toBeCloseTo(80, 6);
    expect(right.separation).toBeCloseTo(80, 6);

    const left = sight({ azimuth: 280, elevation: 0 }, facingNorth, CAMERA, GOOD);
    expect(left.status).toBe("off-screen");
    if (left.status !== "off-screen") return;
    // Negative is to the left: the short way round, not 280 degrees clockwise.
    expect(left.turn).toBeCloseTo(-80, 6);
  });

  it("does not mirror a target that is behind the camera into the frame", () => {
    /*
     * A perspective divide by a negative depth flips the sign of both coordinates, so a
     * satellite directly behind the user's head projects neatly into the middle of the
     * frame. The marker would sit on the horizon ahead, pointing at nothing.
     */
    const behind = sight({ azimuth: 180, elevation: 0 }, facingNorth, CAMERA, GOOD);

    expect(behind.status).toBe("off-screen");
    if (behind.status !== "off-screen") return;
    expect(behind.separation).toBeCloseTo(180, 4);
    expect(Math.abs(behind.turn)).toBeCloseTo(180, 4);
  });

  it("says a target below the horizon cannot be pointed at, rather than where to turn", () => {
    // The Earth is in the way. Sending someone spinning round looking for an object on
    // the far side of the planet is how an AR finder loses their trust.
    const result = sight({ azimuth: 90, elevation: -12 }, facingNorth, CAMERA, GOOD);

    expect(result.status).toBe("below-horizon");
    if (result.status !== "below-horizon") return;
    expect(result.elevation).toBe(-12);
  });

  it("carries the compass uncertainty into every sighting it draws", () => {
    // A position with no stated doubt is a claim of precision. The uncertainty travels
    // with the coordinates so the caller cannot draw one without the other.
    const fair = sight({ azimuth: 0, elevation: 0 }, facingNorth, CAMERA, calibrationFrom(2, 90));

    expect(fair.status).toBe("on-screen");
    if (fair.status !== "on-screen") return;
    expect(fair.uncertaintyDegrees).toBe(35);
  });
});

describe("orientationFrom", () => {
  const radians = (degrees: number): number => (degrees * Math.PI) / 180;

  /*
   * G is written out rather than normalised to 1 because both units occur in practice:
   * expo-sensors reports the Accelerometer in g and DeviceMotion in m/s^2. The vector
   * is normalised before use, so both must give the same answer, and one test below
   * asserts exactly that.
   */
  const G = 9.81;

  it("points at the horizon when the phone is held upright", () => {
    // Upright: world up runs along the screen, so gravity is entirely on y.
    const orientation = orientationFrom(120, { x: 0, y: G, z: 0 });

    expect(orientation?.pitch).toBeCloseTo(0, 4);
    // Heading comes from the location service, not from any motion sensor: it is the
    // only source that knows the magnetic declination, and therefore true north.
    expect(orientation?.heading).toBe(120);
  });

  it("points at the zenith when the phone is lying on its face", () => {
    expect(orientationFrom(0, { x: 0, y: 0, z: -G })?.pitch).toBeCloseTo(90, 4);
  });

  it("points at the ground when the phone is lying on its back", () => {
    expect(orientationFrom(0, { x: 0, y: 0, z: G })?.pitch).toBeCloseTo(-90, 4);
  });

  it("tells above the horizon from below it, which the reported angle cannot", () => {
    /*
     * THE BUG THIS PREVENTS, MEASURED ON A DEVICE.
     *
     * Android derives its tilt from SensorManager.getOrientation, whose pitch is
     * defined over a quarter turn either side of level. Held flat, upright, then tilted
     * until the camera aimed 45 degrees up, it reported beta of 0, 86 and 45: the value
     * climbs to vertical and reflects. So beta of 45 means BOTH 45 up and 45 down, and
     * an implementation reading it could never point at the sky at all.
     *
     * Gravity separates the two, because the two attitudes genuinely differ in which
     * side of the screen plane the world is on.
     */
    const up45 = orientationFrom(0, {
      x: 0,
      y: G * Math.cos(radians(45)),
      z: -G * Math.sin(radians(45)),
    });
    expect(up45?.pitch).toBeCloseTo(45, 4);

    const down45 = orientationFrom(0, {
      x: 0,
      y: G * Math.cos(radians(45)),
      z: G * Math.sin(radians(45)),
    });
    expect(down45?.pitch).toBeCloseTo(-45, 4);
  });

  it("reports roll positive when the top of the phone goes right", () => {
    // Verified on a device: tilting clockwise moves the marker anticlockwise.
    const rolled = orientationFrom(0, {
      x: -Math.sin(radians(25)),
      y: Math.cos(radians(25)),
      z: 0,
    });
    expect(rolled?.roll).toBeCloseTo(25, 4);
    expect(rolled?.pitch).toBeCloseTo(0, 4);
  });

  it("accepts a reading in g as readily as one in metres per second squared", () => {
    const inG = orientationFrom(0, { x: 0, y: 0, z: 1 });
    const inMetres = orientationFrom(0, { x: 0, y: 0, z: G });
    expect(inG?.pitch).toBeCloseTo(inMetres?.pitch ?? NaN, 6);
    expect(inG?.pitch).toBeCloseTo(-90, 4);
  });

  it("refuses to guess an attitude it cannot measure", () => {
    /*
     * No sample yet, or free fall. An earlier version fell back to the platform tilt
     * angle here, which is the computation now known to be wrong on Android -- so the
     * fallback would have pointed confidently at the wrong patch of sky rather than
     * failing visibly. The caller has to handle absence instead.
     */
    expect(orientationFrom(0, undefined)).toBeUndefined();
    expect(orientationFrom(0, { x: 0, y: 0, z: 0 })).toBeUndefined();
  });
});

describe("calibrationFrom", () => {
  it("refuses to aim without a location fix", () => {
    /*
     * THE BUG THIS PREVENTS.
     *
     * expo-location returns trueHeading of -1 when it has no position, because magnetic
     * declination is a function of where you are and cannot be computed without it.
     * Quietly using magHeading instead is the classic mistake: it is correct in London,
     * where declination is currently near zero, and wrong by more than 15 degrees
     * across most of North America.
     */
    const calibration = calibrationFrom(3, -1);

    expect(calibration.level).toBe("unusable");
    expect(canAim(calibration)).toBe(false);
    expect(calibration.reason).toContain("true north");
    // Not merely "worse than 50": unbounded, and approaching 180 near the magnetic poles.
    expect(calibration.uncertaintyDegrees).toBe(180);
  });

  it("uses the platform's own published uncertainty bands", () => {
    // Apple documents these against its accuracy values; they are not our invention and
    // must not drift from what the platform means by them.
    expect(calibrationFrom(3, 90).uncertaintyDegrees).toBe(20);
    expect(calibrationFrom(2, 90).uncertaintyDegrees).toBe(35);
    expect(calibrationFrom(1, 90).uncertaintyDegrees).toBe(50);
    expect(calibrationFrom(0, 90).uncertaintyDegrees).toBeGreaterThan(50);
  });

  it("never claims a phone compass is better than 20 degrees", () => {
    /*
     * The ceiling on this whole feature, asserted so it cannot quietly be raised.
     *
     * Twenty degrees is forty full moons across. No amount of smoothing or filtering
     * makes a phone magnetometer better than its best documented band, and drawing a
     * crosshair implies otherwise.
     */
    for (const accuracy of [0, 1, 2, 3, 4, 99]) {
      expect(calibrationFrom(accuracy, 90).uncertaintyDegrees).toBeGreaterThanOrEqual(20);
    }
  });

  it("explains what to do about a bad compass, except when it is good", () => {
    expect(calibrationFrom(3, 90).reason).toBe("");
    expect(calibrationFrom(2, 90).reason).toContain("figure of eight");
    expect(calibrationFrom(0, 90).reason).toContain("figure of eight");
  });
});

describe("canAim", () => {
  it("stops the interface pointing when the compass cannot support it", () => {
    // A pointer from an unusable compass is worse than none: confidently wrong, with
    // nothing on screen to suggest it might be.
    expect(canAim(calibrationFrom(3, 90))).toBe(true);
    expect(canAim(calibrationFrom(2, 90))).toBe(true);
    expect(canAim(calibrationFrom(1, 90))).toBe(false);
    expect(canAim(calibrationFrom(0, 90))).toBe(false);
    expect(canAim(calibrationFrom(3, -1))).toBe(false);
  });
});

describe("uncertaintyRadius", () => {
  it("scales the doubt to the frame", () => {
    // Half of a 60 degree field is 30, so a 30 degree cone fills half the frame width.
    expect(uncertaintyRadius(30, CAMERA)).toBeCloseTo(1, 6);
    expect(uncertaintyRadius(0, CAMERA)).toBe(0);
  });

  it("grows the circle as the field of view narrows", () => {
    // The same angular doubt covers more of a zoomed-in frame, which is what makes a
    // narrow lens feel precise while being no such thing.
    const wide = uncertaintyRadius(20, { horizontalFov: 90, verticalFov: 90 });
    const narrow = uncertaintyRadius(20, { horizontalFov: 30, verticalFov: 30 });

    expect(narrow).toBeGreaterThan(wide);
  });
});

describe("smoothing", () => {
  it("passes the first sample straight through", () => {
    // Nothing to average against yet, and starting from zero would make the overlay
    // sweep in from the ground every time the screen opens.
    expect(smoothGravity(undefined, { x: 0, y: 0, z: 1 }, 0.15)).toEqual({ x: 0, y: 0, z: 1 });
    expect(smoothBearing(undefined, 47, 0.2)).toBe(47);
  });

  it("moves a fraction of the way toward each new sample", () => {
    const next = smoothGravity({ x: 0, y: 0, z: 0 }, { x: 10, y: 20, z: 30 }, 0.5);
    expect(next).toEqual({ x: 5, y: 10, z: 15 });
  });

  it("converges on a steady reading", () => {
    let g = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 200; i += 1) g = smoothGravity(g, { x: 0, y: 0, z: 1 }, 0.15);
    expect(g.z).toBeCloseTo(1, 6);
  });

  it("takes the short way round north instead of through south", () => {
    /*
     * THE BUG THIS PREVENTS. Averaging 359 and 1 arithmetically gives 180, which is the
     * exact opposite bearing: the overlay would fling itself across the whole sky every
     * time the user pointed near north.
     */
    expect(smoothBearing(359, 1, 0.5)).toBeCloseTo(0, 6);
    expect(smoothBearing(1, 359, 0.5)).toBeCloseTo(0, 6);
    expect(smoothBearing(350, 10, 1)).toBeCloseTo(10, 6);
  });

  it("stays within 0 to 360", () => {
    expect(smoothBearing(359, 5, 1)).toBeGreaterThanOrEqual(0);
    expect(smoothBearing(359, 5, 1)).toBeLessThan(360);
    expect(smoothBearing(1, 355, 1)).toBeGreaterThanOrEqual(0);
    expect(smoothBearing(1, 355, 1)).toBeLessThan(360);
  });
});
