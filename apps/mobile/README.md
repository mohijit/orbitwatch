# OrbitWatch mobile

Expo / React Native application. Native UI throughout, with the 3D globe rendered by a
locally bundled CesiumJS scene inside a WebView — see
[ADR 0003](../../docs/adr/0003-mobile-renderer.md) for why, and for the device
benchmark gate that is still outstanding.

## Status: Milestone 0

What exists today is the renderer proof of concept:

- the typed, validated bridge protocol (`@orbitwatch/contracts`),
- the WebView globe scene and its host component,
- the packed position encoding, benchmarked at 313 KB per 20,000-object update.

The Expo application shell, navigation, screens and EAS build configuration land in
**M5**. Expo SDK and React Native versions are pinned then, against the SDK current at
that time, rather than guessed now and left to drift.

## Why Expo Go is not enough

`react-native-webview` is a native module, so a development build is required. This is
expected and is called out in the milestone plan.
