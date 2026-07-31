"use strict";

const { spawn } = require("child_process");

function probePlate(ffmpegPath, plate) {
  const probePath = plate.firstFile || plate.inputPath;

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-i", probePath], {
      windowsHide: true
    });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", () => {
      try {
        const videoLine = stderr.split(/\r?\n/).find((line) => line.includes("Video:"));
        const dimensions = videoLine && videoLine.match(/(?:,|\s)(\d{2,5})x(\d{2,5})(?:[,\s])/);

        if (!dimensions) {
          throw new Error("FFmpeg не определил разрешение plate.");
        }

        const detectedFps = parseFps(videoLine);
        const fps = plate.kind === "sequence" || plate.kind === "image"
          ? 24
          : detectedFps || 24;
        const duration = plate.kind === "sequence"
          ? plate.frameCount / fps
          : plate.kind === "image"
            ? 1 / fps
            : parseDuration(stderr) || 1 / fps;

        resolve({
          width: Number.parseInt(dimensions[1], 10),
          height: Number.parseInt(dimensions[2], 10),
          fps,
          durationSeconds: duration,
          frameCount: plate.frameCount || Math.max(1, Math.round(duration * fps)),
          codecLine: videoLine.trim()
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseFps(videoLine) {
  const fpsMatch = String(videoLine).match(/(\d+(?:\.\d+)?)\s*fps\b/i);

  if (fpsMatch) {
    return Number(fpsMatch[1]);
  }

  const tbrMatch = String(videoLine).match(/(\d+(?:\.\d+)?)\s*tbr\b/i);
  return tbrMatch ? Number(tbrMatch[1]) : null;
}

function parseDuration(text) {
  const match = String(text).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);

  if (!match) {
    return null;
  }

  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
}

function buildSourcePreviewJob({ ffmpegPath, plate, inputColorSpace, ocio }) {
  if (!plate || !plate.media) {
    throw new Error("Исходный plate не проанализирован.");
  }

  const width = Number(plate.media.width);
  const height = Number(plate.media.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("Не удалось определить размер исходного plate.");
  }
  if (!inputColorSpace || !ocio || !ocio.configPath || !ocio.display || !ocio.view) {
    throw new Error("Не заданы параметры OCIO для исходного preview.");
  }

  return {
    ffmpegPath,
    plate,
    canvas: {
      baseWidth: Math.round(width),
      baseHeight: Math.round(height),
      width: Math.round(width),
      height: Math.round(height),
      left: 0,
      top: 0
    },
    fps: Number(plate.media.fps || plate.fps || 24),
    inputColorSpace,
    ocio: {
      configPath: ocio.configPath,
      display: ocio.display,
      view: ocio.view
    }
  };
}

module.exports = {
  buildSourcePreviewJob,
  parseDuration,
  parseFps,
  probePlate
};
