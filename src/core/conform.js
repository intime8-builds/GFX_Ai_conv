"use strict";

const fs = require("fs");
const path = require("path");
const { evaluateTrack, parseNkFile } = require("./nk-parser");

const SEQUENCE_FPS = 24;
const MIN_DURATION_SECONDS = 4;
const MAX_DURATION_SECONDS = 15;

function resolveLatestTrack(selectedPath) {
  if (!selectedPath || !fs.existsSync(selectedPath)) {
    throw new Error("Папка трека не существует.");
  }

  const stats = fs.statSync(selectedPath);

  if (stats.isFile()) {
    if (!selectedPath.toLowerCase().endsWith(".nk")) {
      throw new Error("Файл трека должен иметь расширение .nk.");
    }

    return describeTrackFile(selectedPath);
  }

  const cameraDir = findCameraDirectory(selectedPath);
  const versionDirs = fs.readdirSync(cameraDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^v\d+$/i.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      number: Number.parseInt(entry.name.slice(1), 10),
      path: path.join(cameraDir, entry.name)
    }))
    .sort((left, right) => right.number - left.number);

  const searchDirs = versionDirs.length > 0
    ? versionDirs
    : [{ name: path.basename(cameraDir), number: null, path: cameraDir }];

  for (const versionDir of searchDirs) {
    const files = fs.readdirSync(versionDir.path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /_distort_v\d+\.nk$/i.test(entry.name))
      .map((entry) => path.join(versionDir.path, entry.name))
      .sort(compareVersionedPathsDescending);

    if (files.length > 0) {
      return describeTrackFile(files[0], versionDir.number);
    }
  }

  throw new Error(`В ${cameraDir} не найден файл *_distort_vNNN.nk.`);
}

function findCameraDirectory(selectedPath) {
  const normalized = path.resolve(selectedPath);
  const candidates = [
    normalized,
    path.join(normalized, "3d_track", "camera"),
    path.join(normalized, "camera")
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
      continue;
    }

    const name = path.basename(candidate).toLowerCase();
    const hasVersions = fs.readdirSync(candidate, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && /^v\d+$/i.test(entry.name));

    if (name === "camera" || hasVersions) {
      return candidate;
    }
  }

  throw new Error("Не найдена папка 3d_track\\camera с версиями vNNN.");
}

function describeTrackFile(filePath, directoryVersion = null) {
  const parsed = parseNkFile(filePath);
  const fileVersion = versionFromName(path.basename(filePath));

  return {
    ...parsed,
    version: fileVersion === null ? directoryVersion : fileVersion,
    cameraDir: path.dirname(path.dirname(filePath)),
    shotName: shotNameFromTrack(filePath)
  };
}

function shotNameFromTrack(filePath) {
  return path.basename(filePath)
    .replace(/_distort_v\d+\.nk$/i, "")
    .replace(/\.nk$/i, "");
}

function compareVersionedPathsDescending(left, right) {
  return (versionFromName(path.basename(right)) || 0) - (versionFromName(path.basename(left)) || 0);
}

function versionFromName(name) {
  const match = String(name).match(/v(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function discoverPlateDirectory(selectedDirectory) {
  if (!selectedDirectory || !fs.existsSync(selectedDirectory) || !fs.statSync(selectedDirectory).isDirectory()) {
    throw new Error("Папка исходного plate не существует.");
  }

  const absoluteDirectory = path.resolve(selectedDirectory);
  const groups = new Map();

  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".exr") {
      continue;
    }

    const frameMatch = path.parse(entry.name).name.match(/^(.*?)(\d+)$/);
    if (!frameMatch) {
      continue;
    }

    const key = `${frameMatch[1].toLowerCase()}\0${frameMatch[2].length}`;
    const group = groups.get(key) || [];
    group.push({
      name: entry.name,
      number: Number.parseInt(frameMatch[2], 10)
    });
    groups.set(key, group);
  }

  const candidates = Array.from(groups.values())
    .sort((left, right) => {
      if (right.length !== left.length) {
        return right.length - left.length;
      }
      return left[0].name.localeCompare(right[0].name);
    });

  if (candidates.length === 0) {
    throw new Error("В выбранной папке не найдена нумерованная EXR-секвенция.");
  }

  const firstFrame = candidates[0].sort((left, right) => left.number - right.number)[0];
  return discoverPlate(path.join(absoluteDirectory, firstFrame.name));
}

function discoverPlate(selectedFile) {
  if (!selectedFile || !fs.existsSync(selectedFile) || !fs.statSync(selectedFile).isFile()) {
    throw new Error("Исходный plate не существует или не является файлом.");
  }

  const absolutePath = path.resolve(selectedFile);

  if (path.extname(absolutePath).toLowerCase() !== ".exr") {
    return {
      kind: "file",
      selectedPath: absolutePath,
      inputPath: absolutePath,
      displayName: path.basename(absolutePath),
      frameCount: null,
      startNumber: null,
      endNumber: null,
      fps: null
    };
  }

  const parsed = path.parse(absolutePath);
  const match = parsed.name.match(/^(.*?)(\d+)$/);

  if (!match) {
    return {
      kind: "image",
      selectedPath: absolutePath,
      inputPath: absolutePath,
      displayName: parsed.base,
      frameCount: 1,
      startNumber: null,
      endNumber: null,
      fps: SEQUENCE_FPS
    };
  }

  const prefix = match[1];
  const padding = match[2].length;
  const framePattern = new RegExp(`^${escapeRegExp(prefix)}(\\d{${padding}})\\.exr$`, "i");
  const frames = fs.readdirSync(parsed.dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const frameMatch = entry.name.match(framePattern);
      return frameMatch
        ? { number: Number.parseInt(frameMatch[1], 10), name: entry.name }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.number - right.number);

  if (frames.length === 0) {
    throw new Error("Не удалось собрать EXR-секвенцию.");
  }

  const startNumber = frames[0].number;

  for (let index = 0; index < frames.length; index += 1) {
    const expected = startNumber + index;

    if (frames[index].number !== expected) {
      throw new Error(`В EXR-секвенции отсутствует кадр ${expected}.`);
    }
  }

  return {
    kind: "sequence",
    selectedPath: absolutePath,
    inputPath: path.join(parsed.dir, `${prefix}%0${padding}d.exr`).replace(/\\/g, "/"),
    firstFile: path.join(parsed.dir, frames[0].name),
    displayName: `${prefix}[${String(startNumber).padStart(padding, "0")}-${String(frames.at(-1).number).padStart(padding, "0")}].exr`,
    frameCount: frames.length,
    startNumber,
    endNumber: frames.at(-1).number,
    fps: SEQUENCE_FPS
  };
}

function calculateDuration(sourceDuration, requestedSeconds = null) {
  const finiteSource = Number.isFinite(sourceDuration) && sourceDuration > 0 ? sourceDuration : 0;
  const automatic = requestedSeconds === null || requestedSeconds === undefined || requestedSeconds === "";
  const rawTarget = automatic ? Math.ceil(finiteSource) : Math.ceil(Number(requestedSeconds));
  const targetSeconds = clampInteger(rawTarget, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS, MIN_DURATION_SECONDS);

  return {
    mode: automatic ? "auto" : "custom",
    sourceSeconds: finiteSource,
    targetSeconds,
    padded: finiteSource > 0 && finiteSource < targetSeconds,
    truncated: finiteSource > targetSeconds
  };
}

function calculateCanvas(track, sourceWidth, sourceHeight, resolutionMode = "source") {
  const baseWidth = resolutionMode === "hd" ? 1920 : sourceWidth;
  const baseHeight = resolutionMode === "hd" ? 1080 : sourceHeight;

  if (!(baseWidth > 0) || !(baseHeight > 0)) {
    throw new Error("Нельзя рассчитать холст без разрешения plate.");
  }

  const frames = track.animated && track.curveFrames.length > 0
    ? track.curveFrames
    : [0];
  let minX = 0;
  let minY = 0;
  let maxX = 1;
  let maxY = 1;

  for (const frame of frames) {
    const params = evaluateTrack(track, frame);

    for (const point of boundaryPoints(256)) {
      const mapped = distortToUndistortUnit(point.x, point.y, params);
      minX = Math.min(minX, mapped.x);
      minY = Math.min(minY, mapped.y);
      maxX = Math.max(maxX, mapped.x);
      maxY = Math.max(maxY, mapped.y);
    }
  }

  const symmetricWidthUnits = 2 * Math.max(Math.abs(minX - 0.5), Math.abs(maxX - 0.5), 0.5);
  const symmetricHeightUnits = 2 * Math.max(Math.abs(minY - 0.5), Math.abs(maxY - 0.5), 0.5);
  const requiredWidth = Math.ceil(baseWidth * symmetricWidthUnits);
  const requiredHeight = Math.ceil(baseHeight * symmetricHeightUnits);
  const aspectBlock = Math.ceil(Math.max(requiredWidth / 32, requiredHeight / 18));
  const width = aspectBlock * 32;
  const height = aspectBlock * 18;

  return {
    resolutionMode: resolutionMode === "hd" ? "hd" : "source",
    sourceWidth,
    sourceHeight,
    baseWidth,
    baseHeight,
    width,
    height,
    left: (baseWidth - width) / 2,
    top: (baseHeight - height) / 2,
    bbox: { minX, minY, maxX, maxY },
    expanded: width !== baseWidth || height !== baseHeight
  };
}

function boundaryPoints(segments) {
  const points = [];

  for (let index = 0; index <= segments; index += 1) {
    const position = index / segments;
    points.push(
      { x: position, y: 0 },
      { x: position, y: 1 },
      { x: 0, y: position },
      { x: 1, y: position }
    );
  }

  return points;
}

function distortToUndistortUnit(unitX, unitY, params) {
  const fullX = params.fovXa + (unitX * (params.fovXb - params.fovXa));
  const fullY = params.fovYa + (unitY * (params.fovYb - params.fovYa));
  const radius = Math.hypot(params.filmbackWidth / 2, params.filmbackHeight / 2);
  const x = ((fullX * params.filmbackWidth) - params.lensCenterOffsetX - (params.filmbackWidth / 2)) / radius;
  const y = ((fullY * params.filmbackHeight) - params.lensCenterOffsetY - (params.filmbackHeight / 2)) / radius;
  const r2 = (x * x) + (y * y);
  const r4 = r2 * r2;
  const radial = 1 + (params.distortionDegree2 * r2) + (params.distortionDegree4 * r4);
  const u = params.uDegree2 + (params.uDegree4 * r2);
  const v = params.vDegree2 + (params.vDegree4 * r2);
  const radialX = (x * radial) + (((r2 + (2 * x * x)) * u) + (2 * x * y * v));
  const radialY = (y * radial) + (((r2 + (2 * y * y)) * v) + (2 * x * y * u));
  const phi = params.phiCylindricDirection;
  const bending = params.bCylindricBending;
  const q = Math.sqrt(1 + bending);
  const cosine = Math.cos(phi);
  const sine = Math.sin(phi);
  const h00 = ((cosine * cosine) / q) + ((sine * sine) * q);
  const h01 = (q - (1 / q)) * cosine * sine;
  const h11 = ((cosine * cosine) * q) + ((sine * sine) / q);
  const mappedX = (h00 * radialX) + (h01 * radialY);
  const mappedY = (h01 * radialX) + (h11 * radialY);
  const resultFullX = ((mappedX * radius) + params.lensCenterOffsetX + (params.filmbackWidth / 2)) / params.filmbackWidth;
  const resultFullY = ((mappedY * radius) + params.lensCenterOffsetY + (params.filmbackHeight / 2)) / params.filmbackHeight;

  return {
    x: (resultFullX - params.fovXa) / (params.fovXb - params.fovXa),
    y: (resultFullY - params.fovYa) / (params.fovYb - params.fovYa)
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

module.exports = {
  MAX_DURATION_SECONDS,
  MIN_DURATION_SECONDS,
  SEQUENCE_FPS,
  calculateCanvas,
  calculateDuration,
  discoverPlateDirectory,
  discoverPlate,
  distortToUndistortUnit,
  findCameraDirectory,
  resolveLatestTrack,
  shotNameFromTrack
};
