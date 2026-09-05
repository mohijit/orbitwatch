/**
 * Where to point a phone to see a satellite, and how much to trust the answer.
 *
 * Pure geometry and pure policy: sensors in, screen position out. No camera, no
 * subscriptions, no React. Everything that can be wrong about an AR finder is in here,
 * and none of it needs a device to test.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HONESTY PROBLEM WITH AR SKY FINDING
 *
 * A phone compass is not accurate enough to put a crosshair on a satellite, and no
 * amount of code changes that. Apple publishes the bands its own calibration levels
 * mean, and the BEST of them, 3, is "less than 20 degrees uncertainty". Twenty degrees
 * is forty full moons side by side. A reticle drawn as a point would claim a precision
 * the hardware does not have, and the user would conclude the app is wrong when it is
 * the compass that is vague.
 *
 * So a sighting carries the uncertainty that produced it, and the interface draws a
 * cone rather than a crosshair. "It is somewhere in this circle" is the true statement,
 * and it is still enormously useful: it turns the whole sky into one patch of it.
 *
 * TRUE NORTH IS NOT MAGNETIC NORTH
 * Satellite azimuths are measured from true north. A magnetometer measures magnetic
 * north, and the two differ by the local magnetic declination — more than 15 degrees
 * across much of North America, and unbounded near the poles. The platform converts
 * between them, but only when it knows where the device is, because declination is a
 * function of position. `expo-location` signals that it cannot by returning a
 * trueHeading of -1.
 *
 * That value is the most important input here. Substituting magnetic heading when true
 * heading is unavailable is the classic bug in this feature: it works perfectly in
 * London, where declination is currently near zero, and points at the wrong patch of
 * sky everywhere else. This module refuses to point at all instead.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * A direction in the sky, in plain degrees from true north.
 *
 * Deliberately not orbit-core's `LookAngles`. Those carry branded unit types, which is
 * right for orbital mechanics and wrong here: this is screen geometry, and branding the
 * inputs would make every test construct a fake satellite observation to check a piece
 * of trigonometry. A `LookAngles` still satisfies this shape, so callers pass one
 * straight in.
 */
export interface SkyDirection {
  readonly azimuth: number;
  readonly elevation: number;
}

/** Where the phone is pointed. Degrees; heading is from TRUE north. */
export interface DeviceOrientation {
  readonly heading: number;
  /** Above the horizon. Negative is below. */
  readonly pitch: number;
  /** Rotation about the viewing axis. Positive tilts the top of the phone to the right. */
  readonly roll: number;
}

/** The camera's angular coverage, in degrees. */
export interface CameraGeometry {
  readonly horizontalFov: number;
  readonly verticalFov: number;
}

export type CalibrationLevel = "unusable" | "poor" | "fair" | "good";

export interface Calibration {
  readonly level: CalibrationLevel;
  /**
   * How far the true bearing may be from the reported one, in degrees.
   *
   * Apple's published bands for its own accuracy values, used as they are rather than
   * invented: 3 is under 20 degrees, 2 under 35, 1 under 50, and 0 is worse than 50.
   * Android reports the same 0-3 scale through the same Expo field.
   */
  readonly uncertaintyDegrees: number;
  /** Plain-language reason, for display. Empty when calibration is good. */
  readonly reason: string;
}

/** At or beyond this, a bearing is not worth drawing at all. */
const UNUSABLE_UNCERTAINTY = 50;

/**
 * Interpret the platform's compass report.
 *
 * @param accuracy expo-location's 0-3 calibration level
 * @param trueHeading expo-location's true heading, or -1 when it cannot compute one
 */
export function calibrationFrom(accuracy: number, trueHeading: number): Calibration {
  if (trueHeading < 0) {
    return {
      level: "unusable",
      // Not merely "worse than 50": without knowing where we are, the error is a
      // declination we cannot even bound, and near the magnetic poles it approaches 180.
      uncertaintyDegrees: 180,
      reason:
        "No location fix, so magnetic north cannot be converted to true north. " +
        "Grant location access to aim.",
    };
  }

  if (accuracy >= 3) return { level: "good", uncertaintyDegrees: 20, reason: "" };

  if (accuracy === 2) {
    return {
      level: "fair",
      uncertaintyDegrees: 35,
      reason: "Compass roughly calibrated. Move the phone in a figure of eight to improve it.",
    };
  }

  if (accuracy === 1) {
    return {
      level: "poor",
      uncertaintyDegrees: UNUSABLE_UNCERTAINTY,
      reason:
        "Compass poorly calibrated. Move away from metal and electronics, " +
        "then wave the phone in a figure of eight.",
    };
  }

  return {
    level: "unusable",
    uncertaintyDegrees: 90,
    reason: "Compass uncalibrated. Wave the phone in a figure of eight, away from metal.",
  };
}

/** Device-frame acceleration including gravity. Units are irrelevant; direction is not. */
export interface DeviceGravity {
  /** Across the screen, positive right. */
  readonly x: number;
  /** Up the screen, positive toward the top edge. */
  readonly y: number;
  /** Out of the screen, positive toward the viewer. */
  readonly z: number;
}

/**
 * Below this the accelerometer is reporting noise rather than a direction.
 *
 * Deliberately unit-free. expo-sensors reports the Accelerometer in g and DeviceMotion
 * in metres per second squared, and since the vector is normalised before use, the only
 * thing this threshold has to do is reject a reading with no length -- free fall, a
 * sensor that has not produced a sample yet, or the zero this screen starts at.
 */
const MIN_GRAVITY = 0.1;

/**
 * Turn the sensor readings into one pointing direction, or admit there is not one.
 *
 * TILT COMES FROM GRAVITY, AND ONLY FROM GRAVITY
 * The obvious implementation reads the platform tilt angle, since the W3C convention
 * puts its beta at 0 lying flat and 90 upright. iOS reports that. Android does not: it
 * derives rotation from SensorManager.getOrientation, whose pitch is defined over a
 * quarter turn either side of level, so past vertical it has no range left and
 * REFLECTS. Measured on a real device, holding it flat, upright, then tilted back:
 *
 *   attitude              beta reported     beta - 90     should be
 *   flat on its back        0                 -90           -90
 *   upright                86                  -4             0
 *   camera 45 deg up       45                 -45           +45
 *
 * Beta climbs to 90 and comes back down, so aiming above the horizon is arithmetically
 * indistinguishable from aiming the same angle below it, and the camera can never point
 * at the sky -- the entire purpose of the screen that calls this.
 *
 * Gravity has no such limit. Whatever a platform calls its angles, down is down.
 *
 * THERE IS DELIBERATELY NO FALLBACK TO THE REPORTED ANGLE
 * An earlier version used it when gravity was unavailable. That is a fallback onto a
 * computation now known to be wrong on one of the two platforms, which would not fail
 * visibly -- it would point confidently at the wrong patch of sky, which is the failure
 * this whole module is written to avoid. Undefined instead, so the caller has to say it
 * cannot aim rather than aim badly.
 */
export function orientationFrom(
  trueHeading: number,
  gravity: DeviceGravity | undefined,
): DeviceOrientation | undefined {
  if (gravity === undefined) return undefined;

  const magnitude = Math.hypot(gravity.x, gravity.y, gravity.z);
  if (magnitude < MIN_GRAVITY) return undefined;

  /*
   * World up, in the device axes. The back camera looks along -z, so its elevation
   * above the horizon is the angle between -z and up: flat on its back the phone points
   * at the ground and this gives -90, on its face it gives +90, and every attitude
   * between is continuous with nothing to clamp.
   */
  const upX = gravity.x / magnitude;
  const upY = gravity.y / magnitude;
  const upZ = gravity.z / magnitude;

  return {
    heading: trueHeading,
    pitch: Math.asin(Math.min(1, Math.max(-1, -upZ))) / DEG,
    /*
     * Roll is where world up sits within the screen plane. Rolling the phone clockwise
     * carries up toward the left of the screen, hence the negated x. Verified on a
     * device: tilting clockwise moves the marker anticlockwise, as it should.
     *
     * Degenerate at the zenith, unavoidably: with the camera axis parallel to gravity
     * there is no component of up left in the screen plane, and rotation about that
     * axis is a question only the compass can answer. It matters less than it sounds,
     * because a circle drawn around a point does not change shape when it rotates.
     */
    roll: Math.atan2(-upX, upY) / DEG,
  };
}

/**
 * One step of an exponential low-pass filter over the gravity vector.
 *
 * WHY THE RAW READING CANNOT BE USED DIRECTLY
 * An accelerometer measures gravity plus whatever acceleration the hand is applying,
 * and it cannot separate them. Swept quickly across the sky, a phone reports a "down"
 * that is tilted by its own motion, so the overlay slides away from the sky and comes
 * back when the movement stops. Averaging over a short window rejects that, because
 * hand movement changes sign constantly while gravity does not.
 *
 * The cost is lag: during a fast sweep the marker trails slightly behind. That is the
 * right trade for this feature, which is used by pointing and then holding still, and
 * a marker that lags briefly is far less confusing than one that swings.
 *
 * @param factor 0 to 1. Higher follows the sensor faster and filters less.
 */
export function smoothGravity(
  previous: DeviceGravity | undefined,
  next: DeviceGravity,
  factor: number,
): DeviceGravity {
  if (previous === undefined) return next;
  return {
    x: previous.x + (next.x - previous.x) * factor,
    y: previous.y + (next.y - previous.y) * factor,
    z: previous.z + (next.z - previous.z) * factor,
  };
}

/**
 * The same filter for a bearing, which has to be done the long way round.
 *
 * Averaging 359 and 1 arithmetically gives 180 -- the exact opposite direction. The
 * step is taken along the shorter arc between the two instead, then wrapped back into
 * 0 to 360, so north is not a discontinuity the overlay lurches across.
 */
export function smoothBearing(
  previous: number | undefined,
  next: number,
  factor: number,
): number {
  if (previous === undefined) return next;
  return (((previous + bearingDelta(previous, next) * factor) % 360) + 360) % 360;
}

export type Sighting =
  /**
   * Below the horizon: there is no way to point at it, because the Earth is in the way.
   *
   * A distinct state rather than an off-screen one. Telling somebody to turn around and
   * look down, for an object on the far side of the planet, is how an AR finder teaches
   * people that it does not know what it is doing.
   */
  | { readonly status: "below-horizon"; readonly elevation: number }
  /** Not in frame, with what to do about it. */
  | {
      readonly status: "off-screen";
      /** Degrees to rotate; positive is to the right. */
      readonly turn: number;
      /** Degrees to raise the phone; positive is up. */
      readonly tilt: number;
      /** Great-circle angle between where the camera points and the target. */
      readonly separation: number;
    }
  /** In frame. `x` and `y` run -1..1 across the frame, y positive upward. */
  | {
      readonly status: "on-screen";
      readonly x: number;
      readonly y: number;
      readonly separation: number;
      /** Angular radius the interface must draw around the position. */
      readonly uncertaintyDegrees: number;
    };

const DEG = Math.PI / 180;

type Vector = readonly [number, number, number];

/** East-North-Up unit vector for an azimuth and elevation in degrees. */
function toVector(azimuth: number, elevation: number): Vector {
  const az = azimuth * DEG;
  const el = elevation * DEG;
  const horizontal = Math.cos(el);
  return [horizontal * Math.sin(az), horizontal * Math.cos(az), Math.sin(el)];
}

function dot(a: Vector, b: Vector): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Signed difference between two bearings, in -180..180. */
export function bearingDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/**
 * Where the target falls in the camera's frame.
 *
 * A real perspective projection through the camera's own axes, rather than the usual
 * shortcut of dividing differences in azimuth and elevation by the field of view. That
 * shortcut is fine in the middle of the sky and falls apart exactly where this feature
 * is most used: near the zenith the meridians converge, so a target two degrees away
 * can differ in azimuth by a hundred and eighty, and the shortcut throws it off screen
 * while the user is looking straight at it. Overhead passes are the bright ones.
 */
export function sight(
  target: SkyDirection,
  device: DeviceOrientation,
  camera: CameraGeometry,
  calibration: Calibration,
): Sighting {
  if (target.elevation < 0) {
    return { status: "below-horizon", elevation: target.elevation };
  }

  const t = toVector(target.azimuth, target.elevation);
  const forward = toVector(device.heading, device.pitch);

  // Right and up before roll. `up` is simply 90 degrees further up the same azimuth,
  // which stays orthogonal to forward at every pitch, including straight overhead.
  const heading = device.heading * DEG;
  const pitch = device.pitch * DEG;
  const right0: Vector = [Math.cos(heading), -Math.sin(heading), 0];
  const up0: Vector = [
    -Math.sin(pitch) * Math.sin(heading),
    -Math.sin(pitch) * Math.cos(heading),
    Math.cos(pitch),
  ];

  const roll = device.roll * DEG;
  const cosRoll = Math.cos(roll);
  const sinRoll = Math.sin(roll);
  const right: Vector = [
    right0[0] * cosRoll + up0[0] * sinRoll,
    right0[1] * cosRoll + up0[1] * sinRoll,
    right0[2] * cosRoll + up0[2] * sinRoll,
  ];
  const up: Vector = [
    -right0[0] * sinRoll + up0[0] * cosRoll,
    -right0[1] * sinRoll + up0[1] * cosRoll,
    -right0[2] * sinRoll + up0[2] * cosRoll,
  ];

  const along = dot(t, forward);
  const separation = Math.acos(Math.min(1, Math.max(-1, along))) / DEG;

  const turn = bearingDelta(device.heading, target.azimuth);
  const tilt = target.elevation - device.pitch;

  // Behind the camera. Dividing by `along` here would project it back into the frame,
  // mirrored, and paint a marker on a satellite that is behind the user's head.
  if (along <= 0) return { status: "off-screen", turn, tilt, separation };

  const x = dot(t, right) / along / Math.tan((camera.horizontalFov / 2) * DEG);
  const y = dot(t, up) / along / Math.tan((camera.verticalFov / 2) * DEG);

  if (Math.abs(x) > 1 || Math.abs(y) > 1) {
    return { status: "off-screen", turn, tilt, separation };
  }

  return {
    status: "on-screen",
    x,
    y,
    separation,
    uncertaintyDegrees: calibration.uncertaintyDegrees,
  };
}

/**
 * The uncertainty cone, as a fraction of half the frame width.
 *
 * Its own function so that drawing a sighting means having asked for the size of the
 * doubt around it.
 */
export function uncertaintyRadius(degrees: number, camera: CameraGeometry): number {
  return Math.tan(degrees * DEG) / Math.tan((camera.horizontalFov / 2) * DEG);
}

/**
 * Should the interface aim at all?
 *
 * A pointer drawn from an unusable compass is worse than no pointer: it is confidently
 * wrong, and the user has no way to know that. Below this bar the screen explains
 * itself instead of aiming.
 */
export function canAim(calibration: Calibration): boolean {
  return calibration.uncertaintyDegrees < UNUSABLE_UNCERTAINTY;
}
