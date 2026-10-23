# ADR 0007 — Where the sky finder gets the direction a phone is pointing

- Status: **Accepted.** Tilt is derived from gravity, never from the platform tilt angle.
- Date: 2026-09-05
- Milestone: M9, closed against a real device

## Context

The AR sky finder needs three numbers: which way the phone faces, how far above the
horizon it is aimed, and how far it is rolled. The first comes from `expo-location`,
which is the only source that knows the local magnetic declination and can therefore
report a heading from *true* north. The other two are tilt, and tilt is where this ADR
lives.

The obvious source is the platform's own reported orientation. `expo-sensors` exposes it
as `rotation.beta` and `rotation.gamma` on the W3C convention, where beta is 0 with the
phone flat on its back and 90 with it upright. The camera on the back therefore points at
the horizon at beta 90, so `pitch = beta - 90` is the whole calculation.

That is correct on iOS. It is wrong on Android, and this was found only by running it.

## Measurement

Device: **Android phone, Expo SDK 55 development build.** Holding the phone flat, then
upright, then tilted until the back camera aimed roughly 45 degrees above the horizon:

| attitude | beta reported | `beta - 90` | correct answer |
|---|---|---|---|
| flat on its back | 0 | -90 | -90 |
| upright, camera at the horizon | 86 | -4 | 0 |
| camera 45 degrees up | 45 | -45 | **+45** |

Beta climbs toward 90 and then comes back down. Android derives its rotation from
`SensorManager.getOrientation()`, whose pitch is defined only over a quarter turn either
side of level; past vertical it has no range left and reflects.

The consequence is not an offset or an inverted sign, either of which would have been
obvious. It is that **beta of 45 means both 45 degrees up and 45 degrees down**, so the
camera can never be known to point above the horizon at all. The reported symptom was
that the "degrees up" figure refused to fall as the phone was tilted upward, which is
exactly what an aiming instrument does when it believes it is still pointed at the
ground.

Two further faults surfaced in the same session, both invisible to any test:

- **`DeviceMotion` stalls.** Its event counter stopped advancing partway through a tilt,
  and its first half-dozen measurements carried no acceleration field at all. It is a
  composite of accelerometer, gyroscope and rotation-vector sensors, and any one of them
  can take the listener down. A stalled listener freezes the overlay pointing wherever
  it last knew, which looks identical to a working one.
- **Ten samples a second is a stutter.** The sample rate is the frame rate of the thing
  being aimed, and the original 100ms interval read as jitter rather than as a position.

## Decision

**Tilt is computed from the gravity vector, read from the bare `Accelerometer` at 60Hz
and low-pass filtered.**

Gravity has no quarter-turn limit. Whatever a platform calls its angles, down is down,
and one `asin` covers the full half turn continuously. Both pitch and roll come from the
same vector, so there is one convention in the module rather than two.

`DeviceMotion` is not used. The `Accelerometer` is a single sensor with no composite to
fail underneath it.

**There is deliberately no fallback to the reported angle.** An earlier revision used it
when gravity was unavailable. That is a fallback onto a computation now known to be
wrong on one of the two platforms, and it would not fail visibly: it would point
confidently at the wrong patch of sky. `orientationFrom` returns `undefined` instead, and
the screen says it cannot aim.

The low-pass filter exists because an accelerometer measures gravity plus whatever
acceleration the hand applies and cannot separate them. Swept across the sky, a phone
reports a "down" tilted by its own motion. Averaging over about a tenth of a second
rejects that, because hand movement changes sign constantly while gravity does not. The
compass is filtered along the shorter arc between bearings, so that smoothing 359 and 1
gives 0 rather than due south.

## What this evidence does not support

**Nothing here says the finder is accurate.** It says it points at the right part of the
sky rather than the wrong half of it. Absolute accuracy is bounded by the magnetometer,
which reports at best 20 degrees of uncertainty on Apple's own published bands, and that
is why the screen draws a circle and not a crosshair. That decision is unchanged and
untouched by this ADR.

**It was measured on one Android device.** The `getOrientation` behaviour is a property
of the Android platform API rather than of one handset, so the conclusion should carry.
The `DeviceMotion` stall may well be device- or driver-specific; it is avoided rather
than diagnosed.

**Roll is degenerate at the zenith**, and unavoidably so. With the camera axis parallel
to gravity there is no component of world up left in the screen plane to measure
against, and rotation about that axis is a question only the compass can answer. It
matters less than it sounds, because a circle drawn around a point does not change shape
when it rotates.

## Consequences

- `orientationFrom` takes a gravity vector and returns an optional orientation. Callers
  have to handle a device that cannot report tilt, rather than receiving a plausible
  guess.
- The threshold that rejects an unusable reading is unit-free, because `Accelerometer`
  reports in g and `DeviceMotion` in metres per second squared, and the vector is
  normalised before use. A test asserts both give the same answer.
- The pure module keeps its property: everything that can be wrong about the geometry is
  testable without a device. What this ADR records is precisely the part that was not,
  and the numbers above are the reason the code now looks less obvious than `beta - 90`.
- **Do not "simplify" this back to reading the platform tilt angle.** That is the bug.
