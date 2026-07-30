"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  calculateCanvas,
  calculateDuration,
  discoverPlate,
  discoverPlateDirectory,
  distortToUndistortUnit,
  resolveLatestTrack
} = require("../src/core/conform");
const { evaluateTrack, parseNkText } = require("../src/core/nk-parser");
const { createLogger, summarizeValue } = require("../src/core/logger");

const STATIC_NODE = `
LD_3DE4_Radial_Standard_Degree_4 {
 direction undistort
 tde4_filmback_width_cm 3.22
 tde4_filmback_height_cm 1.814
 tde4_lens_center_offset_x_cm 0
 tde4_lens_center_offset_y_cm 0
 tde4_pixel_aspect 0.998484
 field_of_view_xa_unit 0
 field_of_view_xb_unit 1
 field_of_view_ya_unit 0
 field_of_view_yb_unit 1
 Distortion_Degree_2 0.0491071
 U_Degree_2 0
 V_Degree_2 0
 Quartic_Distortion_Degree_4 -0.0446429
 U_Degree_4 0
 V_Degree_4 0
 Phi_Cylindric_Direction 0
 B_Cylindric_Bending 0
 name TST_0040_lens_v003_1
 label 3840x2160
}
`;

test("parses the supported static 3DE node", () => {
  const track = parseNkText(STATIC_NODE);
  assert.equal(track.nodeClass, "LD_3DE4_Radial_Standard_Degree_4");
  assert.equal(track.direction, "undistort");
  assert.equal(track.animated, false);
  assert.equal(track.parameters.filmbackWidth, 3.22);
  assert.equal(track.parameters.distortionDegree2, 0.0491071);
});

test("parses and evaluates exported Nuke curves", () => {
  const animated = STATIC_NODE.replace(
    "Distortion_Degree_2 0.0491071",
    "Distortion_Degree_2 {{curve x1001 0.1 x1002 0.2 x1003 0.4}}"
  );
  const track = parseNkText(animated);
  assert.equal(track.animated, true);
  assert.deepEqual(track.curveFrames, [1001, 1002, 1003]);
  assert.ok(Math.abs(evaluateTrack(track, 1002.5).distortionDegree2 - 0.3) < 1e-12);
});

test("identity coefficients preserve unit coordinates", () => {
  const track = parseNkText(STATIC_NODE
    .replace("Distortion_Degree_2 0.0491071", "Distortion_Degree_2 0")
    .replace("Quartic_Distortion_Degree_4 -0.0446429", "Quartic_Distortion_Degree_4 0"));
  const result = distortToUndistortUnit(0.23, 0.81, track.parameters);
  assert.ok(Math.abs(result.x - 0.23) < 1e-12);
  assert.ok(Math.abs(result.y - 0.81) < 1e-12);
});

test("duration is rounded to whole seconds and clamped to 4-15", () => {
  assert.deepEqual(calculateDuration(2.2), {
    mode: "auto",
    sourceSeconds: 2.2,
    targetSeconds: 4,
    padded: true,
    truncated: false
  });
  assert.equal(calculateDuration(7.01).targetSeconds, 8);
  assert.equal(calculateDuration(22).targetSeconds, 15);
  assert.equal(calculateDuration(8, 5).targetSeconds, 5);
});

test("canvas is exact 16:9 and source scale is the default", () => {
  const track = parseNkText(STATIC_NODE);
  const canvas = calculateCanvas(track, 3840, 2160);
  assert.equal(canvas.baseWidth, 3840);
  assert.equal(canvas.baseHeight, 2160);
  assert.equal(canvas.width / canvas.height, 16 / 9);
  assert.ok(canvas.width >= 3840);
  assert.ok(canvas.height >= 2160);

  const hdCanvas = calculateCanvas(track, 3840, 2160, "hd");
  assert.equal(hdCanvas.baseWidth, 1920);
  assert.equal(hdCanvas.baseHeight, 1080);
});

test("latest track version and continuous EXR sequence are discovered", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gfx-conform-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const camera = path.join(root, "SHOT_0010", "3d_track", "camera");
  fs.mkdirSync(path.join(camera, "v001"), { recursive: true });
  fs.mkdirSync(path.join(camera, "v003"), { recursive: true });
  fs.writeFileSync(path.join(camera, "v001", "SHOT_0010_distort_v001.nk"), STATIC_NODE);
  fs.writeFileSync(path.join(camera, "v003", "SHOT_0010_distort_v003.nk"), STATIC_NODE);

  const latest = resolveLatestTrack(path.join(root, "SHOT_0010"));
  assert.equal(latest.version, 3);
  assert.match(latest.filePath, /v003/);

  const fromTrackFolder = resolveLatestTrack(path.join(root, "SHOT_0010", "3d_track"));
  assert.equal(fromTrackFolder.version, 3);

  const fromCameraFolder = resolveLatestTrack(camera);
  assert.equal(fromCameraFolder.version, 3);

  const fromVersionFolder = resolveLatestTrack(path.join(camera, "v001"));
  assert.equal(fromVersionFolder.version, 3);

  const plateDir = path.join(root, "plate");
  fs.mkdirSync(plateDir);
  for (const frame of [1001, 1002, 1003]) {
    fs.writeFileSync(path.join(plateDir, `SHOT_0010.${frame}.exr`), "");
  }

  const plate = discoverPlate(path.join(plateDir, "SHOT_0010.1002.exr"));
  assert.equal(plate.kind, "sequence");
  assert.equal(plate.frameCount, 3);
  assert.equal(plate.startNumber, 1001);
  assert.match(plate.inputPath, /%04d\.exr$/);

  fs.writeFileSync(path.join(plateDir, "preview.0001.exr"), "");
  const folderPlate = discoverPlateDirectory(plateDir);
  assert.equal(folderPlate.frameCount, 3);
  assert.match(folderPlate.displayName, /^SHOT_0010/);
});

test("structured logger records events and rotates bounded files", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gfx-logs-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logger = createLogger({
    logDir: root,
    sessionId: "test-session",
    maxBytes: 180,
    retainedFiles: 2
  });

  for (let index = 0; index < 12; index += 1) {
    logger.log("info", "test.event", { index, value: "x".repeat(80) });
  }

  const files = fs.readdirSync(root).filter((name) => name.endsWith(".log"));
  assert.ok(files.includes("app.log"));
  assert.ok(files.length <= 3);
  const current = fs.readFileSync(path.join(root, "app.log"), "utf8").trim();
  const record = JSON.parse(current.split(/\r?\n/).at(-1));
  assert.equal(record.sessionId, "test-session");
  assert.equal(record.event, "test.event");
});

test("log value summarizer handles cycles and long strings", () => {
  const value = { text: "x".repeat(5000) };
  value.self = value;
  const summary = summarizeValue(value);
  assert.match(summary.text, /truncated/);
  assert.equal(summary.self, "[Circular]");
});
