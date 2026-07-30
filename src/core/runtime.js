"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

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

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Python завершился с кодом ${code}.`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (_error) {
        reject(new Error(`Python вернул некорректный JSON: ${stdout.slice(0, 500)}`));
      }
    });
  });
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
