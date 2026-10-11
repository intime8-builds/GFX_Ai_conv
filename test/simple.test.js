"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULTS, sanitizeSettings } = require("../src/simple/settings");
const { validateInstallerAsset } = require("../src/core/update");

test("simple defaults preserve duration and dimensions", () => {
  assert.equal(DEFAULTS.inputFps, 24);
  for (const key of ["width", "height", "rangeStart", "rangeEnd", "outputFps"]) assert.equal(DEFAULTS[key], "");
  assert.equal(DEFAULTS.direction, "ai");
});
test("settings restrict data and retain fractional fps", () => {
  const settings = sanitizeSettings({ inputFps: "24000/1001", unknown: "ignored", flattenAlpha: "true" });
  assert.equal(settings.inputFps, "24000/1001");
  assert.equal(settings.flattenAlpha, false);
  assert.equal(settings.unknown, undefined);
  assert.throws(() => sanitizeSettings({ width: "NaN" }));
});
test("preview updater cannot install conform or a different product", () => {
  const asset = { name: "GFX.Ai.Conv.Simple.Preview-0.3.0-alpha.2-installer-x64.exe", size: 100,
    browser_download_url: "https://github.com/intime8-builds/GFX_Ai_conv/releases/download/simple-v0.3.0-alpha.2/setup.exe",
    digest: `sha256:${"a".repeat(64)}` };
  const repo = { owner: "intime8-builds", name: "GFX_Ai_conv" };
  assert.equal(validateInstallerAsset(asset, repo, "0.3.0-alpha.2", "GFX Ai Conv Simple Preview").version, "0.3.0-alpha.2");
  assert.throws(() => validateInstallerAsset(asset, repo, "0.3.0-alpha.2"));
  assert.throws(() => validateInstallerAsset({ ...asset, name: "GFX.Ai.Conv-0.3.0-alpha.2-installer-x64.exe" }, repo, "0.3.0-alpha.2", "GFX Ai Conv Simple Preview"));
});
