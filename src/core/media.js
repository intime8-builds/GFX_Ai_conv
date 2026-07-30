"use strict";

const fs = require("fs");
const path = require("path");
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

function createSourcePreview(ffmpegPath, plate, outputPath) {
  const sourcePath = plate.firstFile || plate.inputPath;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  return runProcess(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", sourcePath,
    "-map", "0:v:0",
    "-frames:v", "1",
    "-vf", "scale=640:-2:flags=lanczos",
    "-q:v", "3",
    outputPath
  ]).then(() => outputPath);
}

function runProcess(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const message = stderr.split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
      reject(new Error(message || `FFmpeg завершился с кодом ${code}.`));
    });
  });
}

module.exports = {
  createSourcePreview,
  parseDuration,
  parseFps,
  probePlate,
  runProcess
};
