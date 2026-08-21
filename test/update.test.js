"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  isNewerVersion,
  normalizeVersion,
  validateInstallerAsset,
  verifyInstallerDownload
} = require("../src/core/update");

const REPOSITORY = { owner: "intime8-builds", name: "GFX_Ai_conv" };
const SHA256 = "a".repeat(64);

test("compares stable and prerelease versions with SemVer precedence", () => {
  assert.equal(normalizeVersion("v0.2.0-alpha.6"), "0.2.0-alpha.6");
  assert.equal(isNewerVersion("0.2.0-alpha.10", "0.2.0-alpha.9"), true);
  assert.equal(isNewerVersion("0.2.0", "0.2.0-alpha.99"), true);
  assert.equal(isNewerVersion("0.2.0-alpha.6", "0.2.0"), false);
  assert.equal(isNewerVersion("not-a-version", "0.2.0"), false);
});

test("accepts only the expected GitHub installer with size and SHA-256", () => {
  const asset = validateInstallerAsset({
    name: "GFX.Ai.Conv-0.2.0-alpha.6-installer-x64.exe",
    size: 151_000_000,
    digest: `sha256:${SHA256}`,
    browser_download_url: "https://github.com/intime8-builds/GFX_Ai_conv/releases/download/v0.2.0-alpha.6/GFX.Ai.Conv-0.2.0-alpha.6-installer-x64.exe"
  }, REPOSITORY, "0.2.0-alpha.6");

  assert.equal(asset.size, 151_000_000);
  assert.equal(asset.sha256, SHA256);
  assert.equal(asset.version, "0.2.0-alpha.6");
  assert.throws(
    () => validateInstallerAsset({ ...asset, downloadUrl: "https://example.com/update.exe" }, REPOSITORY),
    /официальному GitHub/
  );
  assert.throws(
    () => validateInstallerAsset({ ...asset, digest: "", sha256: "" }, REPOSITORY),
    /SHA-256/
  );
  assert.throws(
    () => validateInstallerAsset(asset, REPOSITORY, "0.2.0-alpha.7"),
    /Версия установщика/
  );
});

test("rejects an incomplete or modified installer", () => {
  const asset = { size: 100, sha256: SHA256 };
  assert.doesNotThrow(() => verifyInstallerDownload(asset, 100, SHA256));
  assert.throws(() => verifyInstallerDownload(asset, 99, SHA256), /не полностью/);
  assert.throws(() => verifyInstallerDownload(asset, 100, "b".repeat(64)), /SHA-256/);
});

test("renderer progress does not depend on CSP-blocked inline styles", () => {
  const root = path.resolve(__dirname, "..");
  const renderer = fs.readFileSync(path.join(root, "src", "renderer", "renderer.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "src", "renderer", "index.html"), "utf8");
  const main = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");

  assert.doesNotMatch(renderer, /style=["']/i);
  assert.doesNotMatch(renderer, /\.style\.width\s*=/);
  assert.match(html, /<progress[^>]+id="updateProgressFill"/);
  assert.match(main, /sandbox:\s*true/);
});
