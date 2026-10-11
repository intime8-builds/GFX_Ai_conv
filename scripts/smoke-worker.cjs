"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "..");
const resources = path.join(root, "dist-simple/win-unpacked/resources");
const worker = path.join(resources, "simple-runtime/gfx-worker/gfx-worker.exe");
const ffmpeg = path.join(resources, "app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe");
const ffprobe = path.join(resources, "app.asar.unpacked/node_modules/ffprobe-static/ffprobe.exe");
const config = path.join(resources, "aces_1.2/config.ocio");
const output = path.join(root, "output", `standalone-${Date.now()}`, "Тест с пробелом");
fs.mkdirSync(output, { recursive: true });
const env = { ...process.env, PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`, PYTHONPATH: "", PYTHONHOME: "", OCIO: "" };
function call(command, payload) {
  const text = execFileSync(worker, [command, "--ffmpeg", ffmpeg, "--ffprobe", ffprobe, "--config", config],
    { input: JSON.stringify(payload), encoding: "utf8", timeout: 120000, windowsHide: true, env, maxBuffer: 32 * 1024 * 1024 });
  const result = text.trim().split(/\r?\n/).map(line => JSON.parse(line)).find(line => line.type === "result");
  assert.ok(result, text);
  return result.result;
}
execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=24", "-frames:v", "6",
  "-c:v", "exr", "-format", "half", "-pix_fmt", "gbrpf32le", "-start_number", "1001", path.join(output, "plate.%04d.exr")], { env, windowsHide: true });
const source = call("analyze", { paths: [output] }).sources[0];
const settings = { outputDir: output, direction: "ai", inputFps: 24, inputColorSpace: "ACES - ACEScg" };
const video = call("run", { source, settings, colorConfirmed: true });
const encoded = call("analyze", { paths: [video.outputPath] }).sources[0];
assert.equal(encoded.frameCount, 6);
assert.equal(encoded.fpsRational, "24");
assert.equal(encoded.pixelFormat, "yuv420p");
assert.equal(encoded.colorSpace, "Output - Rec.709");
const copy = call("run", { source: encoded, settings: { ...settings, direction: "nuke", inputColorSpace: "Output - Rec.709" }, colorConfirmed: true });
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
assert.equal(sha(copy.outputPath), sha(video.outputPath));
assert.ok(fs.existsSync(copy.nukePath));
const png = call("run", { source, settings: { ...settings, exportKind: "png", frameIndex: 3 }, colorConfirmed: true });
assert.equal(call("analyze", { paths: [png.outputPath] }).sources[0].pixelFormat, "uint16");
const report = { pass: true, output, video, nuke: copy, png, cleanPath: env.PATH };
fs.writeFileSync(path.join(root, "dist-simple/standalone-check.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
