# Universal converter implementation

Branch: `codex/simple-ai-converter`, based on `feature/ai-conform` at
`56d8dbc4442d22116be93ee3d97d2510d9530a8c`.

The existing `.github/` directory was untracked before this task. Do not replace
or commit its existing files. Add only the new, separately named preview workflow.

## Contract

- Standalone Windows x64 app, isolated preview identity and settings.
- Local AI preparation and Nuke handoff only; no service uploads or AI presets.
- CPU H.264 CRF 16 medium, yuv420p Rec.709; preserve/copy where possible.
- Full duration and original size by default; EXR defaults to 24 fps.
- Explicit source colorspace and alpha policy. ACES 1.2, ACEScg, sRGB Viewer.
- Nuke handoff preserves native streams/files, generates a relative-path `.nk`.
- Source paths are read-only. No access to production servers is required.

## Work ownership

- Coordinator: backend, main/preload IPC, packaging, tests, integration.
- UI worker: separate `GFX_Ai_conv-ui` worktree, only `src/simple/renderer/*`.
- Independent review: color path and packaging before preview delivery.

## Progress

- Created the requested branch; the old conform branch remains unchanged.
- Examined installed Nuke 16 ACES 1.2 config as a read-only reference.
- Color config/runtime will come from open-source upstream, not Foundry files.

## Verified locally

- 17 backend tests: frames/timing, fractional FPS, decoded video/audio hashes on
  remux, corrupt containers, alpha, explicit matrix, VFR, cancellation, SAR, resize.
- 16 Node tests; old conform behavior remains covered separately.
- Packaged Electron EXE + frozen worker with system-only PATH: conversion,
  previews, retry, clear and saved settings. Standalone EXR half -> MP4/PNG16 ->
  native-copy Nuke handoff also passes through `scripts/smoke-worker.cjs`.
- Actual Nuke 16.0v7 safe-mode checks: synthetic EXR/PNG/MP4 and two sample points
  on a real plate from the user's reference script. All five pass. The network
  source was read only; all copies, renders, and diagnostics are local `output/`.
- Independent Astra review found F1-F7 and drove regression fixes; follow-up
  evidence is in ignored `output/review-astra/`.

## Remaining delivery gates

- Finish final packaged queue pause/stop check after odd-size padding fix.
- Final frozen rebuild, installer/ZIP, independent package review and CI build.
- A real future-version self-update cannot be exercised before a second preview
  exists. Checksum/product/channel guards have automated tests. No signing
  certificate is configured; do not claim trusted signing.
- No specific AI-service compatibility is claimed. Windows VM clean-install
  evidence is separate from the local system-only-PATH test.
