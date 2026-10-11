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
- Color config/runtime come from open-source upstream, not Foundry files.

## Verified locally

- 18 backend tests: frames/timing, fractional FPS, decoded video/audio hashes on
  remux, corrupt containers, alpha, explicit matrix, VFR, cancellation, SAR, resize.
- 20 Node tests; old conform behavior remains covered separately.
- Packaged Electron EXE + frozen worker with system-only PATH: conversion,
  previews, retry, clear and saved settings. Standalone EXR half -> MP4/PNG16 ->
  native-copy Nuke handoff also passes through `scripts/smoke-worker.cjs`.
- Actual Nuke 16.0v7 safe-mode checks: synthetic EXR/PNG/MP4/ProRes-alpha and two
  sample points on a real plate from the user's reference script. All six pass.
  The network source was read only; all copies, renders and diagnostics are local.
- Independent Astra review found F1-F7 and drove regression fixes; follow-up
  evidence is in ignored `output/review-astra/`.

## Delivery verification

- Runtime release commit: `03b964afcfbfb84b42b9386835f9873f48119429`.
- Published preview: [simple-v0.3.0-alpha.1](https://github.com/intime8-builds/GFX_Ai_conv/releases/tag/simple-v0.3.0-alpha.1).
  GitHub asset digests match the final hashes below. Release is prerelease,
  not draft; stable Latest remains `v0.2.0-alpha.6`.
- Queue pause/stop, retry, clear, previews and persisted settings passed in the
  packaged EXE and an actual isolated NSIS installation. Settings also survived
  a fresh process launch. Test user data never used the old Conform directory.
- Independent color/data-preservation review F1-F7 and updater review U1-U3 are
  closed in the tested scope. Evidence: ignored `output/review-astra/`.
- Portable updates explicitly offer a separate per-user installation and launch
  that executable, leaving the portable source folder intact. Installed previews
  retain their custom location. Status writes cannot prevent failure fallback.
- Final CI run `38101598442` succeeded with 20 Node and 18 backend tests plus the
  standalone frozen-worker conversion test. Final artifacts were downloaded
  from this run, not substituted by local packages; SHA256SUMS matched both.
- The CI installer completed successfully in an isolated local test directory.
  Its real Electron UI smoke passed (including frozen-worker conversion), and
  all 10 packaged application source files matched the release checkout.
  Evidence: ignored `output/playwright/real-1791682178303/result.json`.
- Final portable ZIP CRC check passed. The temporary test installation was
  removed through its own verified uninstaller; its EXE and HKCU uninstall
  registration are absent. No existing Conform installation was changed.
- Final installer SHA-256:
  `feb46378ba3b702d17cc8841909ccde1bc4c6feea6dd30f89099520e2e4c1c9c`.
- Final portable ZIP SHA-256:
  `4616e308483f1c4e4b60bef55214946add6e5450cbcf54d4ffa01c9365ca6a6d`.
- Additional ProRes-alpha gate isolated an upstream swscale high-bit YUV-to-RGB
  white-level offset. The bounded zscale integer-RGB fix passes the original
  Nuke tolerance: ACEScg max delta decreased from 0.00675461 to 0.000058204;
  alpha is identical. Same-input OCIO/Nuke transforms differ by at most 3.58e-7.
  Independent acceptance: ignored `output/review-astra/PRORES_COLOR_ACCEPTANCE.txt`.
- Final installed CI worker ProRes -> float EXR recheck passed under a
  system-only PATH. Its output, transformed through the generated script's OCIO
  path, matches Nuke within 0.000058204. Evidence: `output/ci-prores-check.json`.

## Known verification boundaries

- A real future-version self-update cannot be exercised before a second preview
  exists. Checksum/product/channel guards and PowerShell failure handling have
  automated tests. No signing certificate is configured; installers are unsigned.
- No specific AI-service compatibility is claimed. Windows VM clean-install
  evidence is separate from the local system-only-PATH test.
