"use strict";

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, net, shell } = require("electron");
const { spawn } = require("child_process");
const { createHash } = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { pathToFileURL } = require("url");
const ffmpegStaticPath = require("ffmpeg-static");
const {
  calculateCanvas,
  calculateDuration,
  discoverPlate,
  discoverPlateDirectory,
  resolveLatestTrack
} = require("./core/conform");
const { buildSourcePreviewJob, probePlate } = require("./core/media");
const {
  buildPythonEnv,
  findNukeRuntime,
  runPythonJson
} = require("./core/runtime");
const { createLogger, summarizeValue } = require("./core/logger");
const {
  isNewerVersion,
  normalizeVersion,
  validateInstallerAsset,
  verifyInstallerDownload
} = require("./core/update");

const REPO_OWNER = "intime8-builds";
const REPO_NAME = "GFX_Ai_conv";
const UPDATE_CHECK_TIMEOUT_MS = 20_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const TRAY_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAD4SURBVFhH7ZSxEYJQFATpwrbogw5sQKvAwBJISYwowIyMkMAavgwc3hcOxuS+ge7MJnrOPnU0+zNzKE4hpcgSNXKKLFEjp8gSNXKKLFEjp8gSNXKKLFEjp8gSNXKKLFEjp8gSNdq3DJc+LGjDUW7XIkvUaNNzEzok30lyQPTO+ybk0XN53SQ44Nqi/vm7VSJL1EiZ14+pf6+mx14HTXR1uXqNElmiRsqvH7D1FcyH+Q8oqnAbUwPzpzCY8IDoaxAkOWBU/RcsfpZ7IkvUyCmyRI2cIkvUyCmyRI2cIkvUyCmyRI2cIkvUyCmyRI2cIkvUyCmyP0+WPQGxDZvikCMZ/QAAAABJRU5ErkJggg==";
const appDataRoot = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const stableUserDataPath = process.env.GFX_AI_CONV_USER_DATA
  || path.join(appDataRoot, "GFX Ai Conv");
const logDir = path.join(stableUserDataPath, "logs");
const previewsDir = path.join(stableUserDataPath, "previews");
const updatesDir = path.join(stableUserDataPath, "updates");
const jobsDir = path.join(stableUserDataPath, "jobs");
const settingsPath = path.join(stableUserDataPath, "settings.json");
const DEFAULT_SETTINGS = {
  outputMode: "auto",
  outputDir: "",
  lastResolvedOutputDir: "",
  inputColorSpace: "ACES2065-1",
  durationMode: "auto",
  durationSeconds: 4,
  resolutionMode: "hd",
  denoiseStrength: 1,
  lastPlateDir: "",
  lastTrackDir: ""
};

app.disableHardwareAcceleration();
fs.mkdirSync(stableUserDataPath, { recursive: true });
app.setPath("userData", stableUserDataPath);
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disable-gpu-program-cache");

for (const directory of [logDir, previewsDir, updatesDir, jobsDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

pruneFiles(previewsDir, (name) => /\.jpe?g$/i.test(name), 0);
pruneFiles(logDir, (name) => /^worker-.*\.log$/i.test(name), 100);
pruneFiles(updatesDir, (name) => /\.tmp(?:-|$)/i.test(name), 0);

const logger = createLogger({ logDir });
const logEvent = (level, event, details = null) => logger.log(level, event, details);

logEvent("info", "app.bootstrap", {
  version: app.getVersion(),
  packaged: app.isPackaged,
  executable: process.execPath,
  appPath: app.getAppPath(),
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  argv: process.argv
});

process.on("uncaughtException", (error) => {
  logEvent("fatal", "process.uncaughtException", error);
  writeCrashLog("uncaughtException", error);
  dialog.showErrorBox("GFX Ai Conv: ошибка запуска", error.stack || error.message || String(error));
  app.quit();
});

process.on("unhandledRejection", (reason) => {
  logEvent("error", "process.unhandledRejection", reason);
  writeCrashLog("unhandledRejection", reason);
});

const ffmpegPath = resolveBundledPath(ffmpegStaticPath);
const gotSingleInstanceLock = app.requestSingleInstanceLock();
let mainWindow = null;
let tray = null;
let isQuitting = false;
let activeWorker = null;
let runtimeCache = null;
let ocioCache = null;
let quitCleanupStarted = false;
let quitCleanupComplete = false;

if (!gotSingleInstanceLock) {
  logEvent("warn", "app.singleInstanceRejected");
  app.quit();
} else {
  app.on("second-instance", showMainWindow);
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return mainWindow;
  }

  logEvent("info", "window.create");

  const win = new BrowserWindow({
    width: 1240,
    height: 900,
    minWidth: 980,
    minHeight: 720,
    backgroundColor: "#080808",
    title: "GFX Ai Conv",
    icon: createTrayImage(32),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow = win;
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    logEvent(level >= 3 ? "error" : level === 2 ? "warn" : "debug", "renderer.console", {
      message,
      line,
      sourceId
    });
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    logEvent("error", "renderer.didFailLoad", { errorCode, errorDescription, validatedURL });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    logEvent("fatal", "renderer.processGone", details);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    logEvent("warn", "renderer.windowOpenBlocked", { url });
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    logEvent("warn", "renderer.navigationBlocked", { url });
  });
  win.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    logEvent("warn", "renderer.permissionBlocked", { permission });
    callback(false);
  });
  win.on("unresponsive", () => {
    logEvent("error", "window.unresponsive");
  });
  win.on("responsive", () => {
    logEvent("info", "window.responsive");
  });
  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      logEvent("info", "window.hide", { reason: "close" });
      win.hide();
    }
  });
  win.on("minimize", (event) => {
    event.preventDefault();
    logEvent("info", "window.hide", { reason: "minimize" });
    win.hide();
  });
  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });
  win.once("ready-to-show", () => {
    logEvent("info", "window.readyToShow");
    win.show();
    win.focus();
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html")).catch((error) => {
    logEvent("error", "window.loadFailed", error);
  });
  return win;
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) {
    return;
  }

  logEvent("info", "app.ready");
  Menu.setApplicationMenu(null);
  createTray();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", (event) => {
  logEvent("info", "app.beforeQuit", { activeWorker: Boolean(activeWorker) });
  isQuitting = true;

  if (!activeWorker || quitCleanupComplete) {
    return;
  }

  event.preventDefault();
  if (quitCleanupStarted) {
    return;
  }

  quitCleanupStarted = true;
  cancelActiveWorker()
    .catch((error) => logEvent("error", "worker.quitCleanupFailed", error))
    .finally(() => {
      quitCleanupComplete = true;
      app.quit();
    });
});

app.on("window-all-closed", () => {
  if (isQuitting && process.platform !== "darwin") {
    app.quit();
  }
});

handleIpc("dialog:choosePlate", async () => {
  const settings = loadSettings();
  const result = await dialog.showOpenDialog({
    title: "Выберите исходный plate или один кадр EXR-секвенции",
    defaultPath: existingDirectory(settings.lastPlateDir),
    properties: ["openFile"],
    filters: [
      {
        name: "Plate, sequence или видео",
        extensions: ["exr", "dpx", "tif", "tiff", "png", "jpg", "jpeg", "mov", "mp4", "mxf", "avi"]
      },
      { name: "Все файлы", extensions: ["*"] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const plate = discoverPlate(result.filePaths[0]);
  const media = await probePlate(ffmpegPath, plate);
  saveSettings({
    ...settings,
    lastPlateDir: path.dirname(result.filePaths[0])
  });
  return { ...plate, media };
});

handleIpc("dialog:choosePlateFolder", async () => {
  const settings = loadSettings();
  const result = await dialog.showOpenDialog({
    title: "Выберите папку с EXR-секвенцией",
    defaultPath: existingDirectory(settings.lastPlateDir),
    properties: ["openDirectory"]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const selectedDirectory = result.filePaths[0];
  const plate = discoverPlateDirectory(selectedDirectory);
  const media = await probePlate(ffmpegPath, plate);
  saveSettings({
    ...settings,
    lastPlateDir: selectedDirectory
  });

  return { ...plate, media };
});

handleIpc("dialog:chooseTrack", async () => {
  const settings = loadSettings();
  const result = await dialog.showOpenDialog({
    title: "Выберите папку шота, 3d_track, camera или vNNN",
    defaultPath: existingDirectory(settings.lastTrackDir),
    properties: ["openDirectory"]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const track = resolveLatestTrack(result.filePaths[0]);
  saveSettings({
    ...settings,
    lastTrackDir: result.filePaths[0]
  });
  return track;
});

handleIpc("dialog:chooseOutputDir", async () => {
  const settings = loadSettings();
  const result = await dialog.showOpenDialog({
    title: "Выберите папку вывода",
    defaultPath: existingDirectory(settings.outputDir),
    properties: ["openDirectory", "createDirectory"]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

handleIpc("ocio:list", async () => {
  return getOcioInfo();
});

handleIpc("conform:analyze", async (_event, payload) => {
  const plate = payload && payload.plate;
  const track = payload && payload.track;
  const settings = sanitizeSettings(payload && payload.settings);

  if (!plate || !plate.media || !track || !track.filePath) {
    throw new Error("Сначала выберите исходный plate и папку трека.");
  }

  const durationRequest = settings.durationMode === "custom" ? settings.durationSeconds : null;
  const duration = calculateDuration(plate.media.durationSeconds, durationRequest);
  const canvas = calculateCanvas(
    track,
    plate.media.width,
    plate.media.height,
    settings.resolutionMode
  );
  const outputDir = settings.outputMode === "auto"
    ? deriveOutputDir(track)
    : settings.outputDir;

  if (!outputDir) {
    throw new Error("Выберите папку вывода или включите автоматический ai\\conform.");
  }

  const saved = {
    ...settings,
    lastResolvedOutputDir: outputDir
  };
  saveSettings(saved);

  return {
    duration,
    canvas,
    outputDir,
    fps: plate.media.fps,
    shotName: track.shotName,
    warnings: buildAnalysisWarnings(plate, track, duration, canvas)
  };
});

handleIpc("preview:createSource", async (_event, payload) => {
  const settings = sanitizeSettings(payload && payload.settings);
  const ocio = await getOcioInfo();
  const job = buildSourcePreviewJob({
    ffmpegPath,
    plate: payload && payload.plate,
    inputColorSpace: settings.inputColorSpace,
    ocio
  });

  if (!ocio.colorSpaces.includes(job.inputColorSpace)) {
    throw new Error(`Colorspace '${job.inputColorSpace}' отсутствует в текущем Nuke OCIO.`);
  }

  const id = sanitizeFileName(payload.id || Date.now());
  const jobPath = path.join(jobsDir, `source-preview-${id}.json`);
  const outputPath = path.join(previewsDir, `source-${sanitizeFileName(payload.id || Date.now())}.jpg`);
  fs.writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

  try {
    const runtime = getRuntime();
    const result = await runPythonJson(
      runtime,
      bundledPath("vendor", "py311"),
      bundledPath("backend", "preview_worker.py"),
      [jobPath, outputPath, "source"]
    );
    pruneFiles(previewsDir, (name) => /\.jpe?g$/i.test(name), 200);
    return result.path ? pathToFileURL(result.path).href : null;
  } finally {
    safeUnlink(jobPath);
  }
});

handleIpc("preview:createConform", async (_event, payload) => {
  const job = await buildWorkerJob(payload);
  const id = sanitizeFileName(payload.id || Date.now());
  const jobPath = path.join(jobsDir, `preview-${id}.json`);
  const previewPath = path.join(previewsDir, `conform-${id}.jpg`);
  fs.writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

  try {
    const runtime = getRuntime();
    const result = await runPythonJson(
      runtime,
      bundledPath("vendor", "py311"),
      bundledPath("backend", "preview_worker.py"),
      [jobPath, previewPath]
    );
    pruneFiles(previewsDir, (name) => /\.jpe?g$/i.test(name), 200);
    return result.path ? pathToFileURL(result.path).href : null;
  } finally {
    safeUnlink(jobPath);
  }
});

handleIpc("conform:run", async (event, payload) => {
  if (activeWorker) {
    throw new Error("Другая задача уже выполняется.");
  }

  const job = await buildWorkerJob(payload);
  const id = String(payload.id || Date.now());
  const jobPath = path.join(jobsDir, `job-${sanitizeFileName(id)}.json`);
  const cancelPath = path.join(jobsDir, `cancel-${sanitizeFileName(id)}.flag`);
  job.cancelPath = cancelPath;
  safeUnlink(cancelPath);
  fs.writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

  try {
    return await runConformWorker(jobPath, id, event.sender, cancelPath);
  } finally {
    safeUnlink(jobPath);
    safeUnlink(cancelPath);
  }
});

handleIpc("conform:cancel", async () => {
  await cancelActiveWorker();
  return { ok: true };
});

handleIpc("shell:openPath", async (_event, targetPath) => {
  const requestedPath = stringValue(targetPath);
  if (!requestedPath || requestedPath.includes("\0")) {
    throw new Error("Некорректный путь для открытия.");
  }

  const resolvedPath = path.resolve(requestedPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Путь не существует: ${resolvedPath}`);
  }

  const error = await shell.openPath(resolvedPath);
  if (error) {
    throw new Error(error);
  }
  return { ok: true, path: resolvedPath };
});

handleIpc("app:getVersion", () => app.getVersion());
handleIpc("settings:get", () => loadSettings());
handleIpc("settings:save", (_event, settings) => {
  const clean = sanitizeSettings(settings);
  saveSettings(clean);
  return clean;
});
ipcMain.on("logs:renderer", (_event, payload) => {
  const level = payload && payload.level;
  const event = payload && payload.event;
  logEvent(level, `renderer.${event || "event"}`, payload && payload.details);
});
handleIpc("logs:collect", async (_event, payload) => {
  return collectDiagnosticBundle(payload);
});
handleIpc("updates:check", checkForUpdates);
handleIpc("updates:downloadAndInstall", async (event) => {
  if (activeWorker) {
    throw new Error("Сначала остановите текущую конвертацию.");
  }

  const result = await checkForUpdates();

  if (!result.ok) {
    throw new Error(result.error || "Не удалось проверить обновления.");
  }

  if (!result.hasUpdate || !result.installerAsset) {
    return { ok: true, installed: false };
  }

  const installerPath = await downloadUpdateInstaller(result.installerAsset, event.sender);
  sendToRenderer(event.sender, "updates:downloadProgress", { progress: 100, phase: "installing" });
  launchSilentInstallerAfterQuit(installerPath);
  isQuitting = true;
  app.quit();
  return { ok: true, installed: true };
});

async function buildWorkerJob(payload) {
  const plate = payload && payload.plate;
  const track = payload && payload.track;
  const analysis = payload && payload.analysis;
  const settings = sanitizeSettings(payload && payload.settings);

  if (!plate || !track || !analysis || !analysis.canvas || !analysis.duration) {
    throw new Error("Задание не проанализировано.");
  }

  const ocio = await getOcioInfo();

  if (!ocio.colorSpaces.includes(settings.inputColorSpace)) {
    throw new Error(`Colorspace '${settings.inputColorSpace}' отсутствует в текущем Nuke OCIO.`);
  }

  return {
    ffmpegPath,
    plate,
    track,
    canvas: analysis.canvas,
    outputDir: analysis.outputDir,
    shotName: analysis.shotName || track.shotName,
    fps: analysis.fps,
    durationSeconds: analysis.duration.targetSeconds,
    inputColorSpace: settings.inputColorSpace,
    denoiseStrength: settings.denoiseStrength,
    ocio: {
      configPath: ocio.configPath,
      display: ocio.display,
      view: ocio.view
    }
  };
}

function runConformWorker(jobPath, id, sender, cancelPath) {
  return new Promise((resolve, reject) => {
    const runtime = getRuntime();
    const workerLogPath = path.join(
      logDir,
      `worker-${sanitizeFileName(id)}-${Date.now()}.log`
    );
    const appendWorkerLog = (stream, value) => {
      try {
        fs.appendFileSync(
          workerLogPath,
          `[${new Date().toISOString()}] [${stream}] ${String(value).replace(/\s+$/, "")}\n`,
          "utf8"
        );
      } catch (_error) {
        // The main application log remains available if a per-worker log cannot be written.
      }
    };
    const child = spawn(runtime.python, [bundledPath("backend", "conform_worker.py"), jobPath], {
      env: buildPythonEnv(runtime, bundledPath("vendor", "py311")),
      windowsHide: true
    });
    let resolveClosed;
    const closed = new Promise((closedResolve) => {
      resolveClosed = closedResolve;
    });
    const workerState = {
      child,
      cancelPath,
      cancelled: false,
      closed,
      closedSettled: false
    };
    const markClosed = () => {
      if (!workerState.closedSettled) {
        workerState.closedSettled = true;
        resolveClosed();
      }
    };
    activeWorker = workerState;
    logEvent("info", "worker.start", {
      id,
      pid: child.pid,
      python: runtime.python,
      jobPath,
      workerLogPath
    });
    let stdoutBuffer = "";
    let stderr = "";
    let result = null;
    let workerError = null;
    let lastPhase = "";

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        appendWorkerLog("stdout", line);
        try {
          const message = JSON.parse(line);

          if (message.type === "progress") {
            sendToRenderer(sender, "conform:progress", { id, ...message });
            if (message.phase !== lastPhase) {
              lastPhase = message.phase;
              logEvent("info", "worker.phase", { id, phase: message.phase, progress: message.progress });
            }
          } else if (message.type === "result") {
            result = message;
          } else if (message.type === "metrics") {
            logEvent("info", "worker.metrics", { id, ...message.performance });
          } else if (message.type === "error") {
            workerError = message.message;
          }
        } catch (_error) {
          stderr += `${line}\n`;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      appendWorkerLog("stderr", text);
    });
    child.on("error", (error) => {
      logEvent("error", "worker.spawnError", { id, error });
      if (activeWorker === workerState) {
        activeWorker = null;
      }
      markClosed();
      reject(error);
    });
    child.on("close", (code) => {
      if (activeWorker === workerState) {
        activeWorker = null;
      }
      markClosed();
      pruneFiles(logDir, (name) => /^worker-.*\.log$/i.test(name), 100);
      logEvent(code === 0 ? "info" : "error", "worker.close", {
        id,
        code,
        cancelled: workerState.cancelled,
        result,
        error: workerError || compactError(stderr),
        workerLogPath
      });

      if (workerState.cancelled) {
        reject(new Error("Конвертация остановлена."));
        return;
      }

      if (code !== 0 || !result) {
        reject(new Error(workerError || compactError(stderr) || `Backend завершился с кодом ${code}.`));
        return;
      }

      resolve({
        status: "done",
        progress: 100,
        mainPath: result.mainPath,
        topviewPath: result.topviewPath,
        reportPath: result.reportPath
      });
    });
  });
}

async function cancelActiveWorker() {
  const worker = activeWorker;
  if (!worker) {
    return;
  }

  worker.cancelled = true;
  logEvent("info", "worker.cancelRequested", { pid: worker.child.pid });
  try {
    fs.writeFileSync(worker.cancelPath, `${Date.now()}\n`, "utf8");
  } catch (error) {
    logEvent("warn", "worker.cancelFlagFailed", error);
  }

  if (await waitForPromise(worker.closed, 3500)) {
    return;
  }

  logEvent("warn", "worker.cancelForce", { pid: worker.child.pid });
  await forceTerminateProcessTree(worker.child);
  if (!await waitForPromise(worker.closed, 5000)) {
    throw new Error("Backend не завершился после принудительной остановки.");
  }
}

function waitForPromise(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function forceTerminateProcessTree(child) {
  if (!child || child.exitCode !== null) {
    return Promise.resolve();
  }

  if (process.platform !== "win32" || !child.pid) {
    child.kill("SIGKILL");
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.once("error", resolve);
    killer.once("close", resolve);
  });
}

function getRuntime() {
  if (!runtimeCache) {
    logEvent("info", "runtime.searchStart");
    runtimeCache = findNukeRuntime();
    logEvent("info", "runtime.found", {
      version: runtimeCache.version,
      root: runtimeCache.root,
      python: runtimeCache.python,
      ocioConfig: runtimeCache.ocioConfig
    });
  }
  return runtimeCache;
}

async function getOcioInfo() {
  if (!ocioCache) {
    logEvent("info", "ocio.probeStart");
    const runtime = getRuntime();
    ocioCache = await runPythonJson(
      runtime,
      bundledPath("vendor", "py311"),
      bundledPath("backend", "ocio_probe.py"),
      [runtime.ocioConfig]
    );
    ocioCache.runtime = runtime.version;
    logEvent("info", "ocio.probeComplete", {
      runtime: ocioCache.runtime,
      version: ocioCache.ocioVersion,
      configPath: ocioCache.configPath,
      display: ocioCache.display,
      view: ocioCache.view,
      colorSpaceCount: ocioCache.colorSpaces && ocioCache.colorSpaces.length
    });
  }
  return ocioCache;
}

function deriveOutputDir(track) {
  const shotRoot = path.resolve(track.cameraDir, "..", "..");
  return path.join(shotRoot, "ai", "conform");
}

function buildAnalysisWarnings(plate, track, duration, canvas) {
  const warnings = [];

  if (track.animated) {
    warnings.push(`Трек анимирован: ${track.firstCurveFrame}–${track.lastCurveFrame}. ST-map считается для каждого кадра.`);
  }
  if (duration.padded) {
    warnings.push("Короткий plate будет дополнен последним кадром.");
  }
  if (duration.truncated) {
    warnings.push("Plate длиннее выбранной длительности и будет обрезан.");
  }
  if (canvas.resolutionMode === "hd" && (plate.media.width !== 1920 || plate.media.height !== 1080)) {
    warnings.push("Undistort считается в исходном разрешении; затем результат переводится в 1920×1080.");
  }
  if (canvas.resolutionMode === "source" && (plate.media.width > 1920 || plate.media.height > 1080)) {
    warnings.push("Сохранён исходный пиксельный масштаб; 4K не уменьшается до 1920×1080.");
  }

  return warnings;
}

async function checkForUpdates() {
  const currentVersion = app.getVersion();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);

  try {
    const response = await net.fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": `${REPO_NAME}/${currentVersion}`
      },
      signal: controller.signal
    });

    if (response.status === 404) {
      return { ok: true, hasUpdate: false, currentVersion };
    }
    if (!response.ok) {
      throw new Error(`GitHub вернул статус ${response.status}`);
    }

    const release = await response.json();
    const latestVersion = normalizeVersion(release.tag_name || release.name || "");
    if (!latestVersion) {
      throw new Error("GitHub Release содержит некорректную версию.");
    }

    const hasUpdate = isNewerVersion(latestVersion, currentVersion);
    const rawInstallerAsset = Array.isArray(release.assets)
      ? release.assets.find((asset) => /installer-x64\.exe$/i.test(asset.name || ""))
      : null;
    const installerAsset = hasUpdate
      ? validateInstallerAsset(
          rawInstallerAsset,
          { owner: REPO_OWNER, name: REPO_NAME },
          latestVersion
        )
      : null;

    return {
      ok: true,
      currentVersion,
      latestVersion,
      hasUpdate,
      releaseName: release.name || release.tag_name,
      installerAsset
    };
  } catch (error) {
    const message = error && error.name === "AbortError"
      ? "Проверка обновлений превысила 20 секунд."
      : error.message;
    return { ok: false, currentVersion, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadUpdateInstaller(asset, sender) {
  const verifiedAsset = validateInstallerAsset(
    asset,
    { owner: REPO_OWNER, name: REPO_NAME },
    asset && asset.version
  );
  const installerPath = path.join(updatesDir, verifiedAsset.name);
  const tmpPath = `${installerPath}.tmp`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_DOWNLOAD_TIMEOUT_MS);
  let downloadedBytes = 0;
  let completed = false;

  safeUnlink(tmpPath);
  try {
    const response = await net.fetch(verifiedAsset.downloadUrl, {
      headers: { "User-Agent": `${REPO_NAME}/${app.getVersion()}` },
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      throw new Error(`Не удалось скачать установщик. Статус: ${response.status}.`);
    }

    const hash = createHash("sha256");
    const source = Readable.fromWeb(response.body);
    source.on("data", (chunk) => {
      downloadedBytes += chunk.length;
      hash.update(chunk);
      sendToRenderer(sender, "updates:downloadProgress", {
        downloadedBytes,
        totalBytes: verifiedAsset.size,
        progress: Math.min(100, Math.floor((downloadedBytes / verifiedAsset.size) * 100))
      });
    });

    await pipeline(source, fs.createWriteStream(tmpPath, { flags: "wx" }));
    const actualSha256 = hash.digest("hex");
    verifyInstallerDownload(verifiedAsset, downloadedBytes, actualSha256);
    safeUnlink(installerPath);
    fs.renameSync(tmpPath, installerPath);
    completed = true;
    logEvent("info", "updates.downloadVerified", {
      installerPath,
      bytes: downloadedBytes,
      sha256: actualSha256
    });
    return installerPath;
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("Скачивание обновления превысило 30 минут.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (!completed) {
      safeUnlink(tmpPath);
    }
  }
}

function launchSilentInstallerAfterQuit(installerPath) {
  const helperPath = path.join(updatesDir, "install-update.ps1");
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$pidToWait = ${process.pid}`,
    `$installer = '${escapePowerShellString(installerPath)}'`,
    `$appExe = '${escapePowerShellString(process.execPath)}'`,
    "Wait-Process -Id $pidToWait -Timeout 30",
    "Start-Process -FilePath $installer -ArgumentList '/S' -Wait",
    "Start-Sleep -Seconds 2",
    "if (Test-Path $appExe) { Start-Process -FilePath $appExe }"
  ].join("\r\n");

  fs.writeFileSync(helperPath, script, "utf8");
  spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-File", helperPath
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  }).unref();
}

function createTray() {
  if (tray) {
    return;
  }

  tray = new Tray(createTrayImage(16));
  tray.setToolTip("GFX Ai Conv");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Открыть", click: showMainWindow },
    {
      label: "Открыть последнюю папку вывода",
      click: () => {
        const outputDir = loadSettings().lastResolvedOutputDir;
        if (outputDir && fs.existsSync(outputDir)) {
          shell.openPath(outputDir);
        }
      }
    },
    { type: "separator" },
    {
      label: "Выйти",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);
}

function showMainWindow() {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow();
  if (win.isMinimized()) {
    win.restore();
  }
  win.show();
  win.focus();
}

function createTrayImage(size) {
  return nativeImage.createFromDataURL(TRAY_ICON_DATA_URL).resize({ width: size, height: size });
}

function sanitizeSettings(settings) {
  const incoming = settings && typeof settings === "object" ? settings : {};
  return {
    outputMode: incoming.outputMode === "manual" ? "manual" : "auto",
    outputDir: stringValue(incoming.outputDir),
    lastResolvedOutputDir: stringValue(incoming.lastResolvedOutputDir),
    inputColorSpace: stringValue(incoming.inputColorSpace) || "ACES2065-1",
    durationMode: incoming.durationMode === "custom" ? "custom" : "auto",
    durationSeconds: clampInteger(incoming.durationSeconds, 4, 15, 4),
    resolutionMode: incoming.resolutionMode === "source" ? "source" : "hd",
    denoiseStrength: clampNumber(incoming.denoiseStrength, 0, 2, 1),
    lastPlateDir: stringValue(incoming.lastPlateDir),
    lastTrackDir: stringValue(incoming.lastTrackDir)
  };
}

function loadSettings() {
  try {
    if (!fs.existsSync(settingsPath)) {
      return { ...DEFAULT_SETTINGS };
    }
    return sanitizeSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
  } catch (error) {
    writeCrashLog("settingsLoad", error);
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  const clean = sanitizeSettings(settings);
  const tmpPath = `${settingsPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, settingsPath);
}

function bundledPath(...segments) {
  return resolveBundledPath(path.join(app.getAppPath(), ...segments));
}

function resolveBundledPath(value) {
  return String(value || "").replace("app.asar", "app.asar.unpacked");
}

function existingDirectory(value) {
  return value && fs.existsSync(value) ? value : undefined;
}

function compactError(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-8).join("\n");
}

function sanitizeFileName(value) {
  return String(value || "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function escapePowerShellString(value) {
  return String(value).replace(/'/g, "''");
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (_error) {
    // Temporary file cleanup is best-effort.
  }
}

function sendToRenderer(sender, channel, payload) {
  try {
    if (sender && !sender.isDestroyed()) {
      sender.send(channel, payload);
    }
  } catch (error) {
    logEvent("warn", "renderer.sendFailed", { channel, error });
  }
}

function pruneFiles(directory, predicate, retainCount) {
  try {
    const files = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && predicate(entry.name))
      .map((entry) => {
        const filePath = path.join(directory, entry.name);
        return { filePath, modified: fs.statSync(filePath).mtimeMs };
      })
      .sort((left, right) => right.modified - left.modified);

    for (const stale of files.slice(Math.max(0, retainCount))) {
      safeUnlink(stale.filePath);
    }
  } catch (_error) {
    // Generated-file retention is best-effort and must not block startup.
  }
}

function handleIpc(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    const startedAt = Date.now();
    logEvent("debug", "ipc.start", {
      channel,
      args: args.map((value) => summarizeValue(value))
    });

    try {
      const result = await handler(event, ...args);
      logEvent("debug", "ipc.complete", {
        channel,
        durationMs: Date.now() - startedAt,
        result: summarizeValue(result)
      });
      return result;
    } catch (error) {
      logEvent("error", "ipc.failed", {
        channel,
        durationMs: Date.now() - startedAt,
        error
      });
      throw error;
    }
  });
}

async function collectDiagnosticBundle(payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suggestedPath = path.join(app.getPath("downloads"), `GFX-Ai-Conv-logs-${stamp}.zip`);
  let selectedPath = process.env.GFX_AI_CONV_DIAGNOSTICS_PATH?.trim() || "";

  if (!selectedPath) {
    const selection = await dialog.showSaveDialog(mainWindow, {
      title: "Сохранить диагностические логи",
      defaultPath: suggestedPath,
      filters: [{ name: "ZIP archive", extensions: ["zip"] }]
    });

    if (selection.canceled || !selection.filePath) {
      logEvent("info", "logs.collectionCancelled");
      return null;
    }
    selectedPath = selection.filePath;
  }

  const destination = selectedPath.toLowerCase().endsWith(".zip")
    ? selectedPath
    : `${selectedPath}.zip`;
  const stagingDir = path.join(jobsDir, `diagnostics-${logger.sessionId}-${Date.now()}`);
  const temporaryZip = `${destination}.tmp-${process.pid}.zip`;
  fs.mkdirSync(stagingDir, { recursive: true });
  logEvent("info", "logs.collectionStart", { destination });

  try {
    const copiedLogs = path.join(stagingDir, "logs");
    fs.cpSync(logDir, copiedLogs, { recursive: true });
    fs.writeFileSync(
      path.join(stagingDir, "diagnostics.json"),
      `${JSON.stringify(buildDiagnostics(), null, 2)}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(stagingDir, "settings.json"),
      `${JSON.stringify(loadSettings(), null, 2)}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(stagingDir, "queue.json"),
      `${JSON.stringify(summarizeValue(payload || {}), null, 2)}\n`,
      "utf8"
    );

    await compressDirectory(stagingDir, temporaryZip);
    if (fs.existsSync(destination)) {
      fs.unlinkSync(destination);
    }
    fs.renameSync(temporaryZip, destination);
    logEvent("info", "logs.collectionComplete", {
      destination,
      bytes: fs.statSync(destination).size
    });
    shell.showItemInFolder(destination);
    return { path: destination, bytes: fs.statSync(destination).size };
  } catch (error) {
    logEvent("error", "logs.collectionFailed", { destination, error });
    throw error;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    safeUnlink(temporaryZip);
  }
}

function buildDiagnostics() {
  let runtime = null;

  try {
    const found = getRuntime();
    runtime = {
      version: found.version,
      root: found.root,
      python: found.python,
      ocioConfig: found.ocioConfig
    };
  } catch (error) {
    runtime = { error: error.message || String(error) };
  }

  return {
    createdAt: new Date().toISOString(),
    sessionId: logger.sessionId,
    application: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      executable: process.execPath,
      appPath: app.getAppPath(),
      userData: stableUserDataPath,
      ffmpegPath
    },
    process: {
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      versions: process.versions
    },
    operatingSystem: {
      type: os.type(),
      release: os.release(),
      version: os.version(),
      arch: os.arch(),
      hostname: os.hostname(),
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      cpuCount: os.cpus().length,
      cpuModels: [...new Set(os.cpus().map((cpu) => cpu.model))]
    },
    runtime
  };
}

function compressDirectory(sourceDir, destinationPath) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$source = '${escapePowerShellString(sourceDir)}'`,
    `$destination = '${escapePowerShellString(destinationPath)}'`,
    "Compress-Archive -Path (Join-Path $source '*') -DestinationPath $destination -CompressionLevel Optimal -Force"
  ].join("\r\n");

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-WindowStyle", "Hidden",
      "-Command", script
    ], {
      windowsHide: true
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(compactError(stderr) || `Compress-Archive завершился с кодом ${code}.`));
      }
    });
  });
}

function writeCrashLog(kind, error) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const message = error && error.stack ? error.stack : String(error);
    fs.writeFileSync(
      path.join(logDir, `${timestamp}-${kind}.log`),
      `[${new Date().toISOString()}] ${kind}\n${message}\n`,
      "utf8"
    );
  } catch (_error) {
    // No safer recovery is available here.
  }
}
