"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { _electron: electron } = require("playwright");
const root = path.resolve(__dirname, "..");
const fixtures = JSON.parse(fs.readFileSync(path.join(root, "output/smoke/fixtures.json"), "utf8"));
const artifacts = path.join(root, "output/playwright", `real-${Date.now()}`);
fs.mkdirSync(artifacts, { recursive: true });
fixtures.video2 = path.join(artifacts, "second.mov");
fs.copyFileSync(fixtures.video, fixtures.video2);
const userData = path.join(artifacts, "profile");
const env = { ...process.env, GFX_SIMPLE_USER_DATA: userData, GFX_SIMPLE_TEST_HEADLESS: "0", PYTHONPATH: "", PYTHONHOME: "" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.GFX_SIMPLE_USE_PYTHON;
env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;

(async () => {
  const app = await electron.launch({ executablePath: process.env.SMOKE_EXE || require("electron"),
    args: process.env.SMOKE_EXE ? [] : [root], cwd: root, env, timeout: 60000 });
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(60000);
    page.on("pageerror", e => errors.push(e.message));
    await page.waitForFunction(() => document.querySelector("#runtime-status").textContent === "Готов к работе", null, { timeout: 60000 });
    assert.equal(await page.locator("#start-button").isDisabled(), true);
    await app.evaluate(({ dialog }, fixture) => {
      let selection = 0;
      dialog.showOpenDialog = async (_window, options) => ({ canceled: false,
        filePaths: [options.properties.includes("openDirectory") ? fixture.output : (++selection % 2 ? fixture.video : fixture.video2)] });
    }, fixtures);
    await page.locator("#output-button").click();
    await page.locator("#files-button").click();
    await page.waitForFunction(() => document.querySelector("#queue-count").textContent === "1");
    await page.waitForFunction(() => {
      const image = document.querySelector("#preview-image");
      return !image.hidden && image.complete && image.naturalWidth > 100;
    }, null, { timeout: 60000 });
    await page.screenshot({ path: path.join(artifacts, "desktop.png"), fullPage: true });
    assert.equal(await page.locator("#start-button").isEnabled(), true);
    await page.locator("#start-button").click();
    await page.waitForFunction(() => document.querySelectorAll(".job-state.done").length === 1, null, { timeout: 120000 });
    await page.getByRole("button", { name: "Повторить задание", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#queue-count").textContent === "2");
    await page.locator("#start-button").click();
    await page.waitForFunction(() => document.querySelectorAll(".job-state.done").length === 2, null, { timeout: 120000 });
    await page.locator("#faq-button").click();
    assert.equal(await page.locator("#faq-dialog").isVisible(), true);
    await page.locator("#faq-close").click();
    await page.waitForFunction(() => !document.querySelector("#preview-image").hidden);
    await page.screenshot({ path: path.join(artifacts, "completed.png"), fullPage: true });
    for (const width of [860, 390]) {
      await page.setViewportSize({ width, height: 740 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(artifacts, `width-${width}.png`), fullPage: true });
    }
    await page.locator("#clear-button").click();
    if (await page.locator("#clear-dialog").isVisible()) await page.locator("#clear-confirm").click();
    await page.waitForFunction(() => document.querySelector("#queue-count").textContent === "0");
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.locator("#advanced summary").click();
    await page.locator("#width").fill("638");
    await page.locator("#width").dispatchEvent("change");
    await page.locator("#files-button").click();
    await page.waitForFunction(() => document.querySelector("#queue-count").textContent === "1");
    await page.locator("#files-button").click();
    await page.waitForFunction(() => document.querySelector("#queue-count").textContent === "2");
    await page.locator("#start-button").click();
    await page.locator("#pause-button").click();
    await page.waitForFunction(() => document.querySelector("#queue-status").textContent === "На паузе");
    assert.equal(await page.locator(".job-state.done").count(), 1);
    assert.equal(await page.locator(".job-state.pending").count(), 1);
    const beforeStop = fs.readdirSync(fixtures.output).length;
    await page.locator("#start-button").click();
    await page.locator("#stop-button").click();
    await page.waitForFunction(() => document.querySelectorAll(".job-state.cancelled").length === 1);
    assert.equal(fs.readdirSync(fixtures.output).length, beforeStop);
    await page.screenshot({ path: path.join(artifacts, "pause-stop.png"), fullPage: true });
    assert.deepEqual(errors, []);
    const settings = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
    assert.equal(settings.outputDir, fixtures.output);
    fs.writeFileSync(path.join(artifacts, "result.json"), JSON.stringify({ pass: true, executable: process.env.SMOKE_EXE || "development-shell", frozenWorker: true, errors, settings }, null, 2));
    console.log(JSON.stringify({ pass: true, artifacts }));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
