"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function runtimePaths({ packaged, resourcesPath, root }) {
  const resources = packaged ? resourcesPath : path.join(root, "resources");
  const executable = path.join(resources, "simple-runtime", "gfx-worker", "gfx-worker.exe");
  const python = path.join(root, ".venv-simple", "Scripts", "python.exe");
  const binaryPath = (file) => packaged ? file.replace("app.asar", "app.asar.unpacked") : file;
  const command = !packaged && process.env.GFX_SIMPLE_USE_PYTHON === "1" ? python : executable;
  const prefix = command === python ? [path.join(root, "backend", "simple", "worker.py")] : [];
  return { command, prefix, config: path.join(resources, "aces_1.2", "config.ocio"),
    ffmpeg: binaryPath(require("ffmpeg-static")), ffprobe: binaryPath(require("ffprobe-static")) };
}

function checkRuntime(runtime) {
  for (const [key, target] of Object.entries(runtime)) {
    if (key !== "prefix" && !fs.existsSync(target)) throw new Error(`Не найден компонент ${key}: ${target}. Переустановите Simple Preview.`);
  }
}

function terminateTree(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || !child.pid) return resolve();
    if (process.platform !== "win32") {
      child.kill("SIGKILL");
      return resolve();
    }
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => { child.kill(); resolve(); });
    killer.once("close", resolve);
  });
}

function launchWorker(runtime, command, payload, { cancelPath, timeout = 120000, onProgress = () => {}, log = () => {} } = {}) {
  checkRuntime(runtime);
  const args = [...runtime.prefix, command, "--ffmpeg", runtime.ffmpeg, "--ffprobe", runtime.ffprobe, "--config", runtime.config];
  if (cancelPath) args.push("--cancel", cancelPath);
  const env = { ...process.env, PYTHONUTF8: "1", PYTHONNOUSERSITE: "1" };
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  delete env.OCIO;
  const child = spawn(runtime.command, args, { windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
  log("info", "worker.start", { command, pid: child.pid, args });
  let timer;
  const done = new Promise((resolve, reject) => {
    let buffer = "", result, failure, stderr = "", bytes = 0;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024 * 1024) {
        failure = new Error("Backend превысил лимит диагностического вывода.");
        void terminateTree(child);
        return;
      }
      buffer += chunk;
      let position;
      while ((position = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, position);
        buffer = buffer.slice(position + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === "result") result = message.result;
          else if (message.type === "error") failure = new Error(message.message);
          else if (message.type === "progress") onProgress(message);
        } catch { log("warn", "worker.nonJson", line.slice(0, 1000)); }
      }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16000); log("debug", "worker.stderr", chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      log("info", "worker.exit", { command, code });
      if (failure) reject(failure);
      else if (code !== 0 || result === undefined) reject(new Error(stderr.trim() || `Backend завершился с кодом ${code}.`));
      else resolve(result);
    });
    child.stdin.on("error", (error) => log("warn", "worker.stdin", error));
    child.stdin.end(JSON.stringify(payload));
    if (timeout) timer = setTimeout(() => {
      failure = new Error("Backend не ответил вовремя.");
      void terminateTree(child);
    }, timeout);
  });
  return { child, done };
}

module.exports = { runtimePaths, checkRuntime, launchWorker, terminateTree };
