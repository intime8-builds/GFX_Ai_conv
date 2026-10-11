"use strict";

const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, net } = require("electron");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { randomUUID, createHash } = require("crypto");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const { createLogger } = require("../core/logger");
const { normalizeVersion, isNewerVersion, validateInstallerAsset, verifyInstallerDownload } = require("../core/update");
const { DEFAULTS, sanitizeSettings } = require("./settings");
const { runtimePaths, launchWorker, terminateTree } = require("./runtime");

const PRODUCT = "GFX Ai Conv Simple Preview";
const REPOSITORY = { owner: "intime8-builds", name: "GFX_Ai_conv" };
const ROOT = path.resolve(__dirname, "../..");
const DATA = process.env.GFX_SIMPLE_USER_DATA || path.join(process.env.LOCALAPPDATA || os.tmpdir(), PRODUCT);
const SETTINGS = path.join(DATA, "settings.json");
const PREVIEWS = path.join(DATA, "previews");
const JOBS = path.join(DATA, "jobs");
const UPDATES = path.join(DATA, "updates");
for (const directory of [DATA, PREVIEWS, JOBS, UPDATES]) fs.mkdirSync(directory, { recursive: true });
app.setName(PRODUCT);
app.setPath("userData", DATA);
app.setAppUserModelId("com.intime8.gfxaiconv.simple.preview");
app.disableHardwareAcceleration();
const logger = createLogger({ logDir: path.join(DATA, "logs") });
const log = (level, event, details) => logger.log(level, event, details);
const runtime = runtimePaths({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, root: ROOT });
const sources = new Map();
const accessiblePaths = new Set([DATA]);
const background = new Set();
let win, tray, active, quitting = false, pendingUpdate, installing = false, colorsPromise;
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();

process.on("uncaughtException", (error) => {
  log("fatal", "uncaughtException", error);
  dialog.showErrorBox(`${PRODUCT}: ошибка`, error.stack || error.message);
});
process.on("unhandledRejection", (error) => log("error", "unhandledRejection", error));

function settings() {
  try { return sanitizeSettings(JSON.parse(fs.readFileSync(SETTINGS, "utf8"))); }
  catch { return { ...DEFAULTS }; }
}
function persist(value) {
  const clean = sanitizeSettings(value);
  const temporary = `${SETTINGS}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(clean, null, 2), "utf8");
  fs.renameSync(temporary, SETTINGS);
  if (clean.outputDir) accessiblePaths.add(path.resolve(clean.outputDir));
  return clean;
}
function send(channel, data) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, data);
}
function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return { ok: false, error: "Недопустимый источник запроса." };
    try { return { ok: true, value: await handler(...args) }; }
    catch (error) { log("error", channel, error); return { ok: false, error: error.message || String(error) }; }
  });
}
async function backgroundWorker(command, payload) {
  if (background.size >= 2) throw new Error("Предыдущий анализ ещё выполняется. Повторите через несколько секунд.");
  const worker = launchWorker(runtime, command, payload, { log });
  background.add(worker);
  try { return await worker.done; } finally { background.delete(worker); }
}
async function colors() {
  if (!colorsPromise) colorsPromise = backgroundWorker("info", {}).catch((error) => { colorsPromise = undefined; throw error; });
  return colorsPromise;
}
function sourceFor(request) {
  const source = sources.get(request?.source?.id);
  if (!source) throw new Error("Источник больше не доступен. Добавьте файл заново.");
  return source;
}

handle("simple:initial", async () => {
  const saved = settings();
  if (saved.outputDir) accessiblePaths.add(path.resolve(saved.outputDir));
  try { return { version: app.getVersion(), settings: saved, colors: await colors(), runtime: { ready: true } }; }
  catch (error) { return { version: app.getVersion(), settings: saved, colors: { spaces: [], configLabel: "ACES 1.2" }, runtime: { ready: false, error: error.message } }; }
});
handle("simple:settings", persist);
handle("simple:files", async () => {
  const selected = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"], filters: [{ name: "Медиа", extensions: ["mov", "mp4", "exr", "png"] }] });
  return selected.canceled ? [] : selected.filePaths;
});
async function chooseDirectory(title) {
  const selected = await dialog.showOpenDialog(win, { title, properties: ["openDirectory"], defaultPath: settings().outputDir || undefined });
  if (selected.canceled) return null;
  accessiblePaths.add(path.resolve(selected.filePaths[0]));
  return selected.filePaths[0];
}
handle("simple:folder", () => chooseDirectory("Папка EXR/PNG-последовательности"));
handle("simple:output", () => chooseDirectory("Папка результата"));
handle("simple:manifest", async () => {
  const selected = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "Исходное задание", extensions: ["json"] }] });
  return selected.canceled ? null : selected.filePaths[0];
});
handle("simple:analyze", async ({ paths: input }) => {
  if (!Array.isArray(input) || !input.length || input.length > 100 || input.some((p) => typeof p !== "string" || p.length > 32767 || !path.isAbsolute(p))) throw new Error("Некорректный список файлов.");
  const result = await backgroundWorker("analyze", { paths: input });
  for (const source of result.sources) sources.set(source.id, source);
  log("info", "media.analyzed", { count: result.sources.length, errors: result.errors });
  return result;
});
handle("simple:preview", async (request) => {
  const source = sourceFor(request);
  const previewPath = path.join(PREVIEWS, `${randomUUID()}.png`);
  const result = await backgroundWorker("preview", { source, settings: sanitizeSettings(request.settings), colorConfirmed: true, previewPath });
  return { ...result, url: pathToFileURL(result.path).href };
});
handle("simple:run", async (request) => {
  if (active) throw new Error("Уже выполняется задание.");
  if (installing) throw new Error("Выполняется обновление.");
  const source = sourceFor(request), options = sanitizeSettings(request.settings);
  const cancelPath = path.join(JOBS, `cancel-${randomUUID()}.flag`);
  const id = String(request.id || randomUUID());
  const payload = { source, settings: options, colorConfirmed: request.colorConfirmed === true };
  log("info", "job.start", { id, payload });
  const worker = launchWorker(runtime, "run", payload, { cancelPath, timeout: 0, log,
    onProgress: (progress) => send("simple:progress", { ...progress, id }) });
  active = { ...worker, cancelPath, id, cancelled: false };
  const current = active;
  try {
    const result = await worker.done;
    if (current.cancelled && !result.committed) throw new Error("Обработка остановлена.");
    for (const key of ["outputPath", "manifestPath", "nukePath"]) {
      if (!result[key]) continue;
      accessiblePaths.add(path.resolve(result[key]));
      accessiblePaths.add(path.dirname(path.resolve(result[key])));
    }
    accessiblePaths.add(path.resolve(options.outputDir));
    log("info", "job.done", { id, result });
    return result;
  } finally {
    if (active === current) active = undefined;
    await fsp.rm(cancelPath, { force: true });
  }
});
async function cancel() {
  const current = active;
  if (!current) return;
  current.cancelled = true;
  await fsp.writeFile(current.cancelPath, "cancel", "utf8");
  await Promise.race([current.done.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (current.child.exitCode === null) await terminateTree(current.child);
  await current.done.catch(() => {});
}
handle("simple:cancel", cancel);
handle("simple:open", async (target) => {
  if (typeof target !== "string" || !accessiblePaths.has(path.resolve(target))) throw new Error("Путь не относится к выбранной папке или результатам программы.");
  const item = path.resolve(target);
  if (fs.statSync(item).isFile()) shell.showItemInFolder(item);
  else { const error = await shell.openPath(item); if (error) throw new Error(error); }
});
handle("simple:logs", async () => {
  const selected = await dialog.showSaveDialog(win, { defaultPath: `GFX-Simple-logs-${Date.now()}.json`, filters: [{ name: "Диагностический журнал", extensions: ["json"] }] });
  if (selected.canceled) return null;
  const logsDir = path.join(DATA, "logs");
  const records = fs.readdirSync(logsDir).filter((f) => f.endsWith(".log")).map((name) => ({ name, text: fs.readFileSync(path.join(logsDir, name), "utf8") }));
  await fsp.writeFile(selected.filePath, JSON.stringify({ version: app.getVersion(), platform: process.platform, arch: process.arch,
    runtime, settings: settings(), activeJob: active?.id, records }, null, 2), "utf8");
  accessiblePaths.add(path.resolve(selected.filePath));
  return { path: selected.filePath };
});

async function checkUpdates() {
  const response = await net.fetch(`https://api.github.com/repos/${REPOSITORY.owner}/${REPOSITORY.name}/releases?per_page=50`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": PRODUCT }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`GitHub: HTTP ${response.status}. Проверьте сеть или системный proxy.`);
  const releases = await response.json();
  pendingUpdate = undefined;
  for (const release of releases) {
    if (release.draft || !String(release.tag_name).startsWith("simple-v")) continue;
    const version = normalizeVersion(release.tag_name.slice("simple-".length));
    if (!isNewerVersion(version, app.getVersion()) || (pendingUpdate && !isNewerVersion(version, pendingUpdate.version))) continue;
    const asset = release.assets?.find((a) => /^GFX[. ]Ai[. ]Conv[. ]Simple[. ]Preview-.*-installer-x64\.exe$/i.test(a.name));
    if (!asset) continue;
    pendingUpdate = { ...validateInstallerAsset(asset, REPOSITORY, version, PRODUCT), notes: release.body || "" };
  }
  return pendingUpdate ? { available: true, version: pendingUpdate.version, notes: pendingUpdate.notes } : { available: false };
}
handle("simple:updates", checkUpdates);
handle("simple:install", async () => {
  if (active || installing) throw new Error("Остановите очередь перед обновлением.");
  if (!app.isPackaged) throw new Error("Обновление устанавливается только из установленного Simple Preview.");
  await checkUpdates();
  if (!pendingUpdate) return;
  const asset = pendingUpdate;
  const temporary = path.join(UPDATES, `${randomUUID()}.partial`);
  const installer = path.join(UPDATES, asset.name);
  installing = true;
  try {
    send("simple:update-progress", { phase: "download", percent: 0 });
    const response = await net.fetch(asset.downloadUrl, { signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`Не удалось скачать обновление: HTTP ${response.status}.`);
    const file = await fsp.open(temporary, "wx");
    const digest = createHash("sha256");
    let count = 0;
    try {
      for await (const chunk of response.body) {
        count += chunk.length;
        if (count > asset.size) throw new Error("Размер обновления превышает заявленный.");
        digest.update(chunk);
        await file.writeFile(chunk);
        send("simple:update-progress", { phase: "download", percent: count / asset.size * 100 });
      }
    } finally { await file.close(); }
    verifyInstallerDownload(asset, count, digest.digest("hex"));
    await fsp.rename(temporary, installer);
    send("simple:update-progress", { phase: "install", percent: 100, message: "Приложение закроется для установки и перезапуска." });
    const escaped = installer.replace(/'/g, "''");
    const executable = process.execPath.replace(/'/g, "''");
    const script = `Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue; $p = Start-Process -FilePath '${escaped}' -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait; if ($p.ExitCode -eq 0) { Start-Process -FilePath '${executable}' -WindowStyle Hidden }`;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { detached: true, windowsHide: true, stdio: "ignore" });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    quitting = true;
    app.quit();
  } finally {
    installing = false;
    await fsp.rm(temporary, { force: true });
  }
});

function showWindow() { if (win && !win.isDestroyed()) { win.show(); win.restore(); win.focus(); } }
function createWindow() {
  win = new BrowserWindow({ width: 1120, height: 850, minWidth: 800, minHeight: 650, title: PRODUCT,
    backgroundColor: "#111111", show: false, webPreferences: { preload: path.join(__dirname, "preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.on("render-process-gone", (_event, details) => log("error", "renderer.gone", details));
  win.webContents.on("console-message", (...args) => log("debug", "renderer.console", args.length > 2 ? args.slice(1, 4) : args[1]));
  win.on("close", (event) => { if (!quitting && tray) { event.preventDefault(); win.hide(); } });
  win.once("ready-to-show", () => { if (process.env.GFX_SIMPLE_TEST_HEADLESS !== "1") win.show(); });
  void win.loadFile(path.join(__dirname, "renderer", "index.html"));
  try {
    const icon = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAD4SURBVFhH7ZSxEYJQFATpwrbogw5sQKvAwBJISYwowIyMkMAavgwc3hcOxuS+ge7MJnrOPnU0+zNzKE4hpcgSNXKKLFEjp8gSNXKKLFEjp8gSNXKKLFEjp8gSNXKKLFEjp8gSNdq3DJc+LGjDUW7XIkvUaNNzEzok30lyQPTO+ybk0XN53SQ44Nqi/vm7VSJL1EiZ14+pf6+mx14HTXR1uXqNElmiRsqvH7D1FcyH+Q8oqnAbUwPzpzCY8IDoaxAkOWBU/RcsfpZ7IkvUyCmyRI2cIkvUyCmyRI2cIkvUyCmyRI2cIkvUyCmyRI2cIkvUyCmyP0+WPQGxDZvikCMZ/QAAAABJRU5ErkJggg==");
    tray = new Tray(icon);
    tray.setToolTip(PRODUCT);
    tray.setContextMenu(Menu.buildFromTemplate([{ label: "Открыть", click: showWindow }, { label: "Выход", click: () => { quitting = true; app.quit(); } }]));
    tray.on("double-click", showWindow);
  } catch (error) { log("warn", "tray.unavailable", error); }
}
app.on("second-instance", showWindow);
app.whenReady().then(() => {
  if (!locked) return;
  Menu.setApplicationMenu(null);
  log("info", "app.start", { version: app.getVersion(), packaged: app.isPackaged, executable: process.execPath, runtime });
  createWindow();
});
let cleanup = false;
app.on("before-quit", (event) => {
  quitting = true;
  if (cleanup) return;
  event.preventDefault();
  cleanup = true;
  void (async () => {
    await cancel();
    for (const task of background) await terminateTree(task.child);
    app.quit();
  })().catch((error) => { log("error", "app.quit", error); app.exit(1); });
});
app.on("window-all-closed", () => { if (!tray || quitting) app.quit(); });
