# Changelog

## 1.0.4 — 2026-08-28

- Fixed aircraft icons never appearing: MapLibre `addImage()` now receives `ImageData` instead of a raw canvas.
- Restored true-altitude placement when the MapLibre build supports `symbol-height-offset`, with an automatic flat-symbol fallback on MapLibre 5.
- Set Mapterhorn terrain encoding to Terrarium so elevation tiles decode correctly.
- Fixed the CodePen proofs so the loader dismisses and the simulated aircraft render.


## 1.0.3 — 2026-08-28

- Replaced the MapLibre 6 split-worker build with the proven single-file MapLibre 5 build.
- Changed startup so the base aircraft map opens before terrain is requested.
- Added the card version to the loading screen and a hard eight-second startup failure state.

## 1.0.2 — 2026-08-28

- Bundled MapLibre and its CSS into the HACS JavaScript file.
- Removed the runtime CDN dependency that could leave Home Assistant on an infinite loading screen.
- Added automatic flat-map fallback when the external terrain service is unavailable.

## 1.0.1 — 2026-08-27

- Fixed the map remaining on the loading screen when a tile request is slow or blocked.
- Added a fallback CDN and clear startup timeout errors for MapLibre.
- Prevented HACS validation failures caused only by missing GitHub About metadata.

## 1.0.0 — 2026-08-27

- Initial public release.
- Added satellite and dark 3D terrain maps.
- Added true-altitude aircraft symbols, trails and smooth position interpolation.
- Added aircraft focus, follow, orbit and fullscreen controls.
- Added airport ground-vehicle filtering and emergency squawk highlighting.
- Added a Home Assistant visual configuration editor.
