# What has been confirmed on real hardware

Most of this project is verified in CI, which is where verification belongs. This file
exists for the part that cannot be: a headless runner has no magnetometer, no camera, no
GPU worth measuring and no Hermes. Every claim below was produced by running the app on a
physical device, and each says what it does **not** establish as well as what it does.

Results are recorded here rather than left in commit messages, because a claim nobody can
find is not much better than one nobody made.

## Android, Expo SDK 55 development build — 2026-09-05

Device: Android phone, `dev.orbitwatch.app`, EAS `development` profile.

### ✅ M5 install gate (Android half)

An EAS development build installs and runs. The custom permission strings from
`app.json` appear as written, which Expo Go could not have shown, because it ships a
fixed native binary that no config plugin can alter.

**Not established:** the iOS half. It needs a paid Apple Developer account, and there is
no free path from a Windows machine.

### ✅ M6 cross-platform agreement

The in-app agreement screen reports **agreement across 16 cases and 628 quantities**.

This is the half of M6 that cannot be faked from a laptop. The native app runs on
Hermes, not V8, and Hermes hands several `Math` functions to the platform C library — so
the same arithmetic can produce different digits on an Android phone than in a desktop
browser. Everything in this product rests on the claim that they nonetheless agree about
where to look.

The comparison is against a committed fixture generated once on Node, never against
another platform's live run. Two platforms agreeing with each other proves nothing when
both run the same library; that is the shape of a shared bug, not of a passing test.

Tolerances are physical rather than numerical: **1e-6 degrees** of angle, **1 metre** of
distance, **1 second** of pass time. The suite passes when the platforms agree about the
sky, not when their doubles are bit-identical.

**Not established:** that the numbers are *correct*. That is what the Vallado SGP4 suite
in `orbit-core` is for. This says only that the phone reproduces them.

### ✅ M9 AR sky finder

Aims correctly, tilts through the full range, and rolls in the right direction. Three
faults were found here that no test could have caught, all of them facts about the
device rather than about the code — recorded in
[ADR 0007](adr/0007-device-tilt-on-android.md), which exists because the fix now looks
stranger than the bug did.

**Not established:** absolute accuracy, and deliberately not. It is bounded by the
magnetometer at roughly 20 degrees, which is why the screen draws a circle rather than a
crosshair.

### ✅ Watchlist sync storage

Migration `0009_watchlist_sync.sql` is applied to the hosted database: the endpoint
answers with a domain-level `NOT_FOUND` rather than a database error, so the table
exists and the query runs.

**Not established:** the round trip between two devices.

## iPhone 14, iOS 26.6.1, mobile Safari — 2026-09-05

### ✅ M8.5 mobile web performance

60 fps at 16,655 objects. Recorded with its caveats in
[ADR 0006](adr/0006-mobile-web-performance.md) — the short version being that a 60Hz
panel floors frame time at 16.7ms, so the bench proved the work fits and could not
measure by how much.

## Still outstanding

| What | Why it is not done |
|---|---|
| M5 globe in the mobile app | Not a test gap. The Cesium runtime has never been bundled into the app's assets, and the screen says so rather than pointing at a CDN. ADR 0003's device gate waits on that build step. |
| iOS device build | Paid Apple Developer account, unavailable from Windows without one. |
| Pass alerts on a device | Scheduling and cancellation are unit-tested; delivery is not. |
| Offline cache on a device | Untested in airplane mode. |
| Deep links and sharing | Untested from a real share sheet. |
| Watchlist sync round trip | Needs two devices, or one device and a browser. |
