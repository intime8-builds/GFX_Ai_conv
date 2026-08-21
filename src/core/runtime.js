"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PYTHON_TIMEOUT_MS = 2 * 60_000;
const MAX_PYTHON_OUTPUT_BYTES = 4 * 1024 * 1024;

function findNukeRuntime() {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const candidates = fs.readdirSync(programFiles, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^Nuke\d/i.test(entry.name))
    .map((entry) => path.join(programFiles, entry.name))
    .sort((left, right) => compareVersions(path.basename(right), path.basename(left)));

  for (const root of candidates) {
    const python = path.join(root, "python.exe");
    const packages = path.join(root, "pythonextensions", "site-packages");

    if (fs.existsSync(python) && fs.existsSync(path.join(packages, "PyOpenColorIO", "PyOpenColorIO.pyd"))) {
      const ocioConfig = findOcioConfig(root);

      if (ocioConfig) {
        return {
          root,
          python,
          packages,
          ocioConfig,
          version: path.basename(root)
        };
      }
    }
  }

  throw new Error("Не найден Nuke 15–17 с Python, PyOpenColorIO и ACES-конфигурацией.");
}

function findOcioConfig(nukeRoot) {
  const configsDir = path.join(nukeRoot, "plugins", "OCIOConfigs", "configs");

  if (!fs.existsSync(configsDir)) {
    return null;
  }

  const files = fs.readdirSync(configsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".ocio"))
    .map((entry) => path.join(configsDir, entry.name));

  const priorities = [
    /fn-nuke_studio-config-.*_aces-v2\.0_/i,
    /fn-nuke_cg-config-.*_aces-v2\.0_/i,
    /fn-nuke_studio-config-.*_aces-v1\.3_/i,
    /fn-nuke_cg-config-.*_aces-v1\.3_/i
  ];

  for (const pattern of priorities) {
    const match = files
      .filter((file) => pattern.test(path.basename(file)))
      .sort((left, right) => compareVersions(path.basename(right), path.basename(left)))[0];

    if (match) {
      return match;
    }
  }

  const legacy = path.join(configsDir, "nuke-default", "config.ocio");
  return fs.existsSync(legacy) ? legacy : null;
}

function buildPythonEnv(runtime, vendorPath) {
  const pythonPaths = [vendorPath, runtime.packages, process.env.PYTHONPATH]
    .filter(Boolean)
    .join(path.delimiter);

  return {
    ...process.env,
    PYTHONPATH: pythonPaths,
    PATH: [runtime.root, process.env.PATH].filter(Boolean).join(path.delimiter),
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1"
  };
}

function runPythonJson(runtime, vendorPath, scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.python, [scriptPath, ...args], {
      env: buildPythonEnv(runtime, vendorPath),
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const appendOutput = (target, chunk) => {
      if (settled) {
        return target;
      }
      outputBytes += chunk.length;
      if (outputBytes > MAX_PYTHON_OUTPUT_BYTES) {
        terminateProcessTree(child);
        settle(reject, new Error("Python превысил допустимый объём диагностического вывода."));
        return target;
      }
      return target + chunk.toString();
    };
    const timeout = setTimeout(() => {
      terminateProcessTree(child);
      settle(reject, new Error("Python preview не завершился за 2 минуты."));
    }, PYTHON_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on("error", (error) => settle(reject, error));
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        settle(reject, new Error(stderr.trim() || `Python завершился с кодом ${code}.`));
        return;
      }

      try {
        settle(resolve, JSON.parse(stdout));
      } catch (_error) {
        settle(reject, new Error(`Python вернул некорректный JSON: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.on("error", () => {
      try {
        child.kill();
      } catch (_error) {
        // The child may have exited between taskkill creation and this callback.
      }
    });
    return;
  }

  try {
    child.kill("SIGKILL");
  } catch (_error) {
    // The child may have already exited.
  }
}

function compareVersions(left, right) {
  const leftParts = String(left).match(/\d+/g)?.map(Number) || [];
  const rightParts = String(right).match(/\d+/g)?.map(Number) || [];
  const count = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < count; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

module.exports = {
  buildPythonEnv,
  findNukeRuntime,
  findOcioConfig,
  runPythonJson
};
