const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Readable } = require("stream");
const { pathToFileURL } = require("url");

const ffmpegStaticPath = require("ffmpeg-static");

const REPO_OWNER = "intime8";
const REPO_NAME = "GFX_Ai_conv";
const TRAY_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAD4SURBVFhH7ZSxEYJQFATpwrbogw5sQKvAwBJISYwowIyMkMAavgwc3hcOxuS+ge7MJnrOPnU0+zNzKE4hpcgSNXKKLFEjp8gSNXKKLFEjp8gSNXKKLFEjp8gSNXKKLFEjp8gSNdq3DJc+LGjDUW7XIkvUaNNzEzok30lyQPTO+ybk0XN53SQ44Nqi/vm7VSJL1EiZ14+pf6+mx14HTXR1uXqNElmiRsqvH7D1FcyH+Q8oqnAbUwPzpzCY8IDoaxAkOWBU/RcsfpZ7IkvUyCmyRI2cIkvUyCmyRI2cIkvUyCmyRI2cIkvUyCmyRI2cIkvUyCmyP0+WPQGxDZvikCMZ/QAAAABJRU5ErkJggg==";
const appDataRoot = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const stableUserDataPath = path.join(appDataRoot, "GFX Ai Conv");
const logDir = path.join(stableUserDataPath, "logs");
const previewsDir = path.join(stableUserDataPath, "previews");
const updatesDir = path.join(stableUserDataPath, "updates");
const settingsPath = path.join(stableUserDataPath, "settings.json");
const DEFAULT_SETTINGS = {
  mode: "png",
  outputDir: "",
  video: {
    durationMode: "full",
    durationSeconds: 4
  }
};

app.disableHardwareAcceleration();
fs.mkdirSync(stableUserDataPath, { recursive: true });
app.setPath("userData", stableUserDataPath);
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disable-gpu-program-cache");

fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(previewsDir, { recursive: true });
fs.mkdirSync(updatesDir, { recursive: true });

process.on("uncaughtException", (error) => {
  writeCrashLog("uncaughtException", error);
  dialog.showErrorBox("GFX Ai Conv crashed", error.stack || error.message || String(error));
  app.quit();
});

process.on("unhandledRejection", (reason) => {
  writeCrashLog("unhandledRejection", reason);
});

function resolveBundledBinary(binaryPath) {
  if (!binaryPath) {
    return binaryPath;
  }

  return binaryPath.replace("app.asar", "app.asar.unpacked");
}

const ffmpegPath = resolveBundledBinary(ffmpegStaticPath);
const gotSingleInstanceLock = app.requestSingleInstanceLock();
let mainWindow = null;
let tray = null;
let isQuitting = false;
let activeConversion = null;

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return mainWindow;
  }

  const windowIcon = createTrayImage(32);
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: "#0d1117",
    title: "GFX Ai Conv",
    icon: windowIcon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow = win;
  win.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    win.hide();
  });
  win.on("minimize", (event) => {
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  return win;
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) {
    return;
  }

  Menu.setApplicationMenu(null);
  createTray();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (isQuitting && process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("dialog:chooseOutputDir", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose output folder",
    properties: ["openDirectory", "createDirectory"]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle("shell:openPath", async (_event, targetPath) => {
  if (!targetPath) {
    return;
  }

  await shell.openPath(targetPath);
});

ipcMain.handle("shell:openExternal", async (_event, url) => {
  if (!url) {
    return;
  }

  await shell.openExternal(url);
});

ipcMain.handle("app:getVersion", () => app.getVersion());

ipcMain.handle("settings:get", () => loadSettings());

ipcMain.handle("settings:save", (_event, settings) => {
  const nextSettings = sanitizeSettings(settings);
  saveSettings(nextSettings);
  return nextSettings;
});

ipcMain.handle("updates:check", async () => {
  return checkForUpdates();
});

ipcMain.handle("updates:downloadAndInstall", async (event) => {
  const result = await checkForUpdates();

  if (!result.ok) {
    throw new Error(result.error || "Update check failed.");
  }

  if (!result.hasUpdate || !result.installerAsset) {
    return { ok: true, installed: false, message: "No installer update is available." };
  }

  const installerPath = await downloadUpdateInstaller(result.installerAsset, event.sender);
  event.sender.send("updates:downloadProgress", {
    progress: 100,
    phase: "installing"
  });
  launchSilentInstallerAfterQuit(installerPath);
  isQuitting = true;
  app.quit();

  return { ok: true, installed: true, installerPath };
});

ipcMain.handle("preview:create", async (_event, payload) => {
  const inputPath = payload && payload.path;
  const id = payload && payload.id ? String(payload.id) : `${Date.now()}`;

  if (!inputPath || !fs.existsSync(inputPath)) {
    return null;
  }

  const previewPath = path.join(previewsDir, `${sanitizeFileName(id)}.jpg`);
  const sourcePath = fs.statSync(inputPath).isDirectory()
    ? findExrSequence(inputPath).firstFile
    : inputPath;

  const args = [
    "-hide_banner",
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-frames:v",
    "1",
    "-vf",
    "scale=180:-1:flags=lanczos",
    "-q:v",
    "3",
    previewPath
  ];

  await runFfmpeg(args, { trackActive: false });
  return pathToFileURL(previewPath).href;
});

ipcMain.handle("convert:cancel", async () => {
  if (activeConversion && activeConversion.child) {
    activeConversion.cancelled = true;
    activeConversion.child.kill("SIGTERM");
  }

  return { ok: true };
});

ipcMain.handle("convert:file", async (event, payload) => {
  const file = payload && payload.file;
  const outputDir = payload && payload.outputDir;
  const mode = payload && payload.mode;
  const settings = payload && payload.settings ? payload.settings : {};

  if (!file || !file.path) {
    throw new Error("Input file is missing.");
  }

  if (!outputDir || !fs.existsSync(outputDir)) {
    throw new Error("Output folder does not exist.");
  }

  if (!["png", "video"].includes(mode)) {
    throw new Error("Unknown conversion mode.");
  }

  const id = file.id;
  const inputPath = file.path;

  if (!fs.existsSync(inputPath)) {
    throw new Error("Input file does not exist.");
  }

  event.sender.send("convert:progress", { id, inputPath, progress: 0, status: "converting" });
  const outputPath = await convertOne(inputPath, outputDir, mode, settings, {
    id,
    sender: event.sender
  });
  event.sender.send("convert:progress", { id, inputPath, outputPath, progress: 100, status: "done" });

  return { id, inputPath, outputPath, progress: 100, status: "done" };
});

ipcMain.handle("convert:files", async (event, payload) => {
  const files = Array.isArray(payload.files) ? payload.files : [];
  const outputDir = payload.outputDir;
  const mode = payload.mode;
  const settings = payload.settings || {};

  if (!outputDir || !fs.existsSync(outputDir)) {
    throw new Error("Output folder does not exist.");
  }

  if (!["png", "video"].includes(mode)) {
    throw new Error("Unknown conversion mode.");
  }

  const results = [];

  for (const file of files) {
    const inputPath = file.path;
    const id = file.id;

    if (!inputPath || !fs.existsSync(inputPath)) {
      const errorResult = { id, inputPath, status: "error", error: "Input file does not exist." };
      event.sender.send("convert:progress", errorResult);
      results.push(errorResult);
      continue;
    }

    event.sender.send("convert:progress", { id, inputPath, status: "converting" });

    try {
      const outputPath = await convertOne(inputPath, outputDir, mode, settings, {
        id,
        sender: event.sender
      });
      const doneResult = { id, inputPath, outputPath, status: "done" };
      event.sender.send("convert:progress", doneResult);
      results.push(doneResult);
    } catch (error) {
      const failResult = { id, inputPath, status: "error", error: error.message };
      event.sender.send("convert:progress", failResult);
      results.push(failResult);
    }
  }

  return results;
});

async function checkForUpdates() {
  const currentVersion = app.getVersion();
  const latestUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

  try {
    const response = await fetch(latestUrl, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": `${REPO_NAME}/${currentVersion}`
      }
    });

    if (response.status === 404) {
      return {
        ok: true,
        hasUpdate: false,
        currentVersion,
        message: "No GitHub Releases yet."
      };
    }

    if (!response.ok) {
      throw new Error(`GitHub responded with ${response.status}`);
    }

    const release = await response.json();
    const latestVersion = normalizeVersion(release.tag_name || release.name || "");
    const installerAsset = Array.isArray(release.assets)
      ? release.assets.find((asset) => /installer-x64\.exe$/i.test(asset.name || ""))
      : null;

    return {
      ok: true,
      currentVersion,
      latestVersion,
      hasUpdate: isNewerVersion(latestVersion, currentVersion),
      releaseUrl: release.html_url,
      releaseName: release.name || release.tag_name,
      installerAsset: installerAsset
        ? {
            name: installerAsset.name,
            size: installerAsset.size,
            downloadUrl: installerAsset.browser_download_url
          }
        : null
    };
  } catch (error) {
    return {
      ok: false,
      currentVersion,
      error: error.message
    };
  }
}

async function downloadUpdateInstaller(asset, sender) {
  if (!asset || !asset.downloadUrl || !asset.name) {
    throw new Error("Installer asset is missing from the latest release.");
  }

  const response = await fetch(asset.downloadUrl, {
    headers: {
      "User-Agent": `${REPO_NAME}/${app.getVersion()}`
    }
  });

  if (!response.ok || !response.body) {
    throw new Error(`Installer download failed with ${response.status}.`);
  }

  const totalBytes = Number(response.headers.get("content-length")) || asset.size || 0;
  const installerPath = path.join(updatesDir, sanitizeFileName(asset.name));
  const tmpPath = `${installerPath}.tmp`;
  const fileStream = fs.createWriteStream(tmpPath);
  let downloadedBytes = 0;

  await new Promise((resolve, reject) => {
    Readable.fromWeb(response.body)
      .on("data", (chunk) => {
        downloadedBytes += chunk.length;

        if (sender && totalBytes > 0) {
          sender.send("updates:downloadProgress", {
            downloadedBytes,
            totalBytes,
            progress: Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100))
          });
        }
      })
      .on("error", reject)
      .pipe(fileStream)
      .on("error", reject)
      .on("finish", resolve);
  });

  fs.renameSync(tmpPath, installerPath);
  if (sender) {
    sender.send("updates:downloadProgress", {
      downloadedBytes,
      totalBytes,
      progress: 100
    });
  }

  return installerPath;
}

function launchSilentInstallerAfterQuit(installerPath) {
  const helperPath = path.join(updatesDir, "install-update.ps1");
  const currentExePath = process.execPath;
  const currentPid = process.pid;
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$pidToWait = ${currentPid}`,
    `$installer = '${escapePowerShellString(installerPath)}'`,
    `$appExe = '${escapePowerShellString(currentExePath)}'`,
    `Wait-Process -Id $pidToWait -Timeout 30`,
    `Start-Process -FilePath $installer -ArgumentList '/S' -Wait`,
    `Start-Sleep -Seconds 2`,
    `if (Test-Path $appExe) { Start-Process -FilePath $appExe }`
  ].join("\r\n");

  fs.writeFileSync(helperPath, script, "utf8");
  spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    helperPath
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  }).unref();
}

function escapePowerShellString(value) {
  return String(value).replace(/'/g, "''");
}

function createTray() {
  if (tray) {
    return;
  }

  tray = new Tray(createTrayImage(16));
  tray.setToolTip("GFX Ai Conv");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Open",
      click: showMainWindow
    },
    {
      label: "Open output folder",
      click: () => {
        const outputDir = loadSettings().outputDir;

        if (outputDir && fs.existsSync(outputDir)) {
          shell.openPath(outputDir);
          return;
        }

        dialog.showMessageBox({
          type: "info",
          title: "GFX Ai Conv",
          message: "Output folder is not set yet."
        });
      }
    },
    {
      label: "Check updates",
      click: async () => {
        const result = await checkForUpdates();

        if (result.ok && result.hasUpdate && result.installerAsset) {
          const answer = await dialog.showMessageBox({
            type: "info",
            title: "GFX Ai Conv",
            message: `${result.releaseName || result.latestVersion} is available.`,
            detail: "Download the installer and launch it now?",
            buttons: ["Download", "Later"],
            defaultId: 0,
            cancelId: 1
          });

          if (answer.response === 0) {
            const installerPath = await downloadUpdateInstaller(result.installerAsset, mainWindow ? mainWindow.webContents : null);
            launchSilentInstallerAfterQuit(installerPath);
            isQuitting = true;
            app.quit();
          }

          return;
        }

        dialog.showMessageBox({
          type: result.ok ? "info" : "warning",
          title: "GFX Ai Conv",
          message: result.ok ? "You are on the latest version." : `Update check failed: ${result.error}`
        });
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
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

async function convertOne(inputPath, outputDir, mode, settings, progress = {}) {
  const inputStats = fs.statSync(inputPath);

  if (inputStats.isDirectory()) {
    return convertDirectory(inputPath, outputDir, mode, settings, progress);
  }

  if (mode === "png") {
    const outputPath = uniqueOutputPath(outputDir, inputPath, ".png");
    const args = [
      "-hide_banner",
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      "format=rgba64be",
      "-update",
      "1",
      "-compression_level",
      "6",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "iec61966-2-1",
      "-colorspace",
      "rgb",
      outputPath
    ];

    await runFfmpeg(args, progress);
    return outputPath;
  }

  const outputPath = uniqueOutputPath(outputDir, inputPath, ".mp4", "_h264");
  const duration = getRequestedDurationSeconds(settings);
  const progressDuration = duration || await getInputDurationSeconds(inputPath);
  const filters = buildVideoFilters();
  const losslessArgs = buildLosslessH264Args();

  const args = [
    "-hide_banner",
    "-y",
    ...buildDurationInputArgs(duration),
    "-i",
    inputPath,
    ...buildDurationOutputArgs(duration),
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    filters,
    "-c:v",
    "libx264",
    ...losslessArgs,
    "-profile:v",
    "high10",
    "-pix_fmt",
    "yuv420p10le",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "iec61966-2-1",
    "-colorspace",
    "bt709",
    "-movflags",
    "+faststart",
    outputPath
  ];

  await runFfmpeg(withProgressArgs(args), {
    ...progress,
    durationSeconds: progressDuration
  });
  return outputPath;
}

async function convertDirectory(inputPath, outputDir, mode, settings, progress = {}) {
  const sequence = findExrSequence(inputPath);

  if (mode === "png") {
    const outputPath = uniqueOutputPath(outputDir, inputPath, ".png");
    const args = [
      "-hide_banner",
      "-y",
      "-i",
      sequence.firstFile,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      "format=rgba64be",
      "-update",
      "1",
      "-compression_level",
      "6",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "iec61966-2-1",
      "-colorspace",
      "rgb",
      outputPath
    ];

    await runFfmpeg(args, progress);
    return outputPath;
  }

  const outputPath = uniqueOutputPath(outputDir, inputPath, ".mp4", "_h264");
  const duration = getRequestedDurationSeconds(settings);
  const filters = buildVideoFilters();
  const losslessArgs = buildLosslessH264Args();

  const args = [
    "-hide_banner",
    "-y",
    ...buildDurationInputArgs(duration),
    "-framerate",
    "25",
    "-start_number",
    String(sequence.startNumber),
    "-i",
    sequence.pattern,
    ...buildDurationOutputArgs(duration),
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    filters,
    "-c:v",
    "libx264",
    ...losslessArgs,
    "-profile:v",
    "high10",
    "-pix_fmt",
    "yuv420p10le",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "iec61966-2-1",
    "-colorspace",
    "bt709",
    "-movflags",
    "+faststart",
    outputPath
  ];

  await runFfmpeg(withProgressArgs(args), {
    ...progress,
    durationSeconds: duration || sequence.frameCount / 25
  });
  return outputPath;
}

function buildLosslessH264Args() {
  return ["-preset", "slow", "-crf", "0"];
}

function buildVideoFilters() {
  return "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos,format=yuv420p10le";
}

function getRequestedDurationSeconds(settings) {
  if (!settings || settings.durationMode !== "custom") {
    return null;
  }

  return clampInteger(settings.durationSeconds, 1, 86400, 4);
}

function buildDurationInputArgs(duration) {
  return duration ? ["-stream_loop", "-1"] : [];
}

function buildDurationOutputArgs(duration) {
  return duration ? ["-t", String(duration)] : [];
}

function withProgressArgs(args) {
  const [firstArg, ...restArgs] = args;
  return [firstArg, "-nostats", "-progress", "pipe:1", ...restArgs];
}

function runFfmpeg(args, progress = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      windowsHide: true
    });

    if (progress.trackActive !== false) {
      activeConversion = { child, cancelled: false };
    }
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);

      for (const line of lines) {
        const [key, value] = line.split("=");

        if (!key || !value || !progress.sender || !progress.id || !progress.durationSeconds) {
          continue;
        }

        const seconds = parseProgressSeconds(key, value);

        if (seconds === null) {
          continue;
        }

        const percent = Math.max(0, Math.min(99, Math.floor((seconds / progress.durationSeconds) * 100)));
        progress.sender.send("convert:progress", {
          id: progress.id,
          progress: percent,
          status: "converting"
        });
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      const cancelled = activeConversion && activeConversion.child === child && activeConversion.cancelled;

      if (activeConversion && activeConversion.child === child) {
        activeConversion = null;
      }

      if (cancelled) {
        reject(new Error("Conversion stopped."));
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(compactFfmpegError(stderr) || `FFmpeg exited with code ${code}.`));
    });
  });
}

function parseProgressSeconds(key, value) {
  if (key === "out_time_us" || key === "out_time_ms") {
    const number = Number.parseInt(value, 10);
    return Number.isNaN(number) ? null : number / 1000000;
  }

  if (key === "out_time") {
    const match = value.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);

    if (!match) {
      return null;
    }

    return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
  }

  return null;
}

function findExrSequence(directoryPath) {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exr"));

  if (entries.length === 0) {
    throw new Error("The folder does not contain EXR files.");
  }

  const groups = new Map();

  for (const entry of entries) {
    const match = entry.name.match(/^(.*?)(\d+)(\.exr)$/i);

    if (!match) {
      continue;
    }

    const [, prefix, digits, suffix] = match;
    const key = `${prefix}\u0000${digits.length}\u0000${suffix.toLowerCase()}`;
    const group = groups.get(key) || {
      prefix,
      suffix,
      width: digits.length,
      frames: []
    };

    group.frames.push({
      number: Number.parseInt(digits, 10),
      name: entry.name
    });
    groups.set(key, group);
  }

  const sequence = Array.from(groups.values())
    .sort((left, right) => right.frames.length - left.frames.length)[0];

  if (!sequence || sequence.frames.length === 0) {
    throw new Error("EXR files need numbered names, for example shot_0001.exr.");
  }

  const frames = sequence.frames
    .sort((left, right) => left.number - right.number)
    .filter((frame, index, list) => index === 0 || frame.number !== list[index - 1].number);
  const startNumber = frames[0].number;

  for (let index = 0; index < frames.length; index += 1) {
    const expected = startNumber + index;

    if (frames[index].number !== expected) {
      throw new Error(`EXR sequence has a gap at frame ${expected}.`);
    }
  }

  const patternName = `${sequence.prefix}%0${sequence.width}d${sequence.suffix}`;

  return {
    startNumber,
    firstFile: path.join(directoryPath, frames[0].name),
    pattern: normalizeFfmpegPath(path.join(directoryPath, patternName)),
    frameCount: frames.length
  };
}

function getInputDurationSeconds(inputPath) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-i", inputPath], {
      windowsHide: true
    });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", () => resolve(null));
    child.on("close", () => {
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);

      if (!match) {
        resolve(null);
        return;
      }

      resolve((Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]));
    });
  });
}

function normalizeFfmpegPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function uniqueOutputPath(outputDir, inputPath, extension, suffix = "") {
  const parsed = path.parse(inputPath);
  const safeName = sanitizeFileName(parsed.name) || "converted";
  let candidate = path.join(outputDir, `${safeName}${suffix}${extension}`);
  let index = 1;

  while (fs.existsSync(candidate)) {
    candidate = path.join(outputDir, `${safeName}${suffix}_${index}${extension}`);
    index += 1;
  }

  return candidate;
}

function sanitizeFileName(fileName) {
  return String(fileName || "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
}

function compactFfmpegError(stderr) {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.slice(-8).join("\n");
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);

  if (Number.isNaN(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function normalizeVersion(version) {
  return String(version || "").replace(/^v/i, "").trim();
}

function isNewerVersion(latest, current) {
  const latestParts = normalizeVersion(latest).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const currentParts = normalizeVersion(current).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(latestParts.length, currentParts.length);

  for (let index = 0; index < length; index += 1) {
    const latestPart = latestParts[index] || 0;
    const currentPart = currentParts[index] || 0;

    if (latestPart > currentPart) {
      return true;
    }

    if (latestPart < currentPart) {
      return false;
    }
  }

  return false;
}

function loadSettings() {
  try {
    if (!fs.existsSync(settingsPath)) {
      return { ...DEFAULT_SETTINGS, video: { ...DEFAULT_SETTINGS.video } };
    }

    const raw = fs.readFileSync(settingsPath, "utf8");
    return sanitizeSettings(JSON.parse(raw));
  } catch (error) {
    writeCrashLog("settingsLoad", error);
    return { ...DEFAULT_SETTINGS, video: { ...DEFAULT_SETTINGS.video } };
  }
}

function saveSettings(settings) {
  const tmpPath = `${settingsPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, settingsPath);
}

function sanitizeSettings(settings) {
  const incoming = settings && typeof settings === "object" ? settings : {};
  const incomingVideo = incoming.video && typeof incoming.video === "object" ? incoming.video : {};
  const mode = incoming.mode === "video" ? "video" : "png";
  const outputDir = typeof incoming.outputDir === "string" ? incoming.outputDir : "";
  const durationMode = incomingVideo.durationMode === "custom" ? "custom" : "full";

  return {
    mode,
    outputDir,
    video: {
      durationMode,
      durationSeconds: clampInteger(incomingVideo.durationSeconds, 1, 86400, DEFAULT_SETTINGS.video.durationSeconds)
    }
  };
}

function writeCrashLog(kind, error) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const message = error && error.stack ? error.stack : String(error);
    const body = `[${new Date().toISOString()}] ${kind}\n${message}\n`;
    fs.writeFileSync(path.join(logDir, `${timestamp}-${kind}.log`), body, "utf8");
  } catch (_error) {
    // Nothing else is safe to do here.
  }
}
