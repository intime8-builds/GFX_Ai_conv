"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { installationPlan, installationScript } = require("../src/simple/updates");

test("installed preview keeps its custom installation directory", () => {
  const plan = installationPlan("D:\\Tools\\Simple\\GFX Ai Conv Simple Preview.exe", "C:\\Local", true);
  assert.equal(plan.directory, "D:\\Tools\\Simple");
  assert.equal(plan.portable, false);
});
test("portable update launches separate installed app, not old portable", () => {
  const plan = installationPlan("D:\\Portable\\GFX Ai Conv Simple Preview.exe", "C:\\Local", false);
  assert.equal(plan.executable, "C:\\Local\\Programs\\GFX Ai Conv Simple Preview\\GFX Ai Conv Simple Preview.exe");
  assert.equal(plan.portable, true);
});
test("updater quotes paths and records failure with fallback launch", () => {
  const plan = installationPlan("D:\\User's tools\\GFX Ai Conv Simple Preview.exe", "C:\\Local", true);
  const script = installationScript({ pid: 42, installer: "C:\\User's files\\setup.exe",
    previousExecutable: "D:\\User's tools\\GFX Ai Conv Simple Preview.exe", plan,
    statusFile: "C:\\Local\\update-result.json", version: "0.3.0-alpha.1" });
  assert.ok(script.includes("User''s files"));
  assert.ok(script.includes("/currentuser --updated /D=D:\\User''s tools"));
  assert.ok(script.includes("@{ok=$false"));
  assert.ok(script.includes("$launch = 'D:\\User''s tools"));
  assert.throws(() => installationScript({ pid: "42; bad" }));
});

test("PowerShell updater records installation failure in an apostrophe path", { skip: process.platform !== "win32" }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gfx-updater-'"));
  try {
    const statusFile = path.join(temporary, "status.json");
    const missing = path.join(temporary, "not-present.exe");
    const script = installationScript({ pid: 2147483647, installer: missing, previousExecutable: missing,
      plan: { directory: temporary, executable: missing }, statusFile, version: "0.3.0-alpha.1" });
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 15000, stdio: "pipe" });
    const status = JSON.parse(fs.readFileSync(statusFile, "utf8").replace(/^\uFEFF/, ""));
    assert.equal(status.ok, false);
    assert.equal(status.version, "0.3.0-alpha.1");
    assert.ok(status.message);
  } finally {
    const resolved = fs.realpathSync(temporary);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("gfx-updater-'"));
    fs.rmSync(resolved, { recursive: true });
  }
});
