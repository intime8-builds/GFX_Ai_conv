"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETAINED_FILES = 8;

function createLogger({
  logDir,
  sessionId = createSessionId(),
  maxBytes = DEFAULT_MAX_BYTES,
  retainedFiles = DEFAULT_RETAINED_FILES
}) {
  fs.mkdirSync(logDir, { recursive: true });
  const filePath = path.join(logDir, "app.log");
  rotateLog(filePath, maxBytes, retainedFiles);

  return {
    filePath,
    sessionId,
    log(level, event, details = null) {
      try {
        rotateLog(filePath, maxBytes, retainedFiles);
        const record = {
          timestamp: new Date().toISOString(),
          sessionId,
          pid: process.pid,
          level: normalizeLevel(level),
          event: String(event || "unknown"),
          details: summarizeValue(details)
        };
        fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
      } catch (_error) {
        // Logging must never interrupt conversion or application startup.
      }
    }
  };
}

function rotateLog(filePath, maxBytes = DEFAULT_MAX_BYTES, retainedFiles = DEFAULT_RETAINED_FILES) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < maxBytes) {
    return;
  }

  const parsed = path.parse(filePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rotatedPath = path.join(parsed.dir, `${parsed.name}-${stamp}${parsed.ext}`);
  fs.renameSync(filePath, rotatedPath);

  const rotated = fs.readdirSync(parsed.dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${parsed.name}-`) && entry.name.endsWith(parsed.ext))
    .map((entry) => {
      const fullPath = path.join(parsed.dir, entry.name);
      return { fullPath, modified: fs.statSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.modified - left.modified);

  for (const stale of rotated.slice(retainedFiles)) {
    fs.unlinkSync(stale.fullPath);
  }
}

function summarizeValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: truncate(value.stack || "", 12000)
    };
  }
  if (typeof value === "string") {
    return truncate(value, 4000);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }
  if (Buffer.isBuffer(value)) {
    return `[Buffer ${value.length} bytes]`;
  }
  if (depth >= 5) {
    return Array.isArray(value) ? `[Array ${value.length}]` : "[Object]";
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.slice(0, 30).map((item) => summarizeValue(item, depth + 1, seen));
    if (value.length > 30) {
      output.push(`[${value.length - 30} more items]`);
    }
    return output;
  }

  const output = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, 60)) {
    output[key] = summarizeValue(item, depth + 1, seen);
  }
  if (entries.length > 60) {
    output.__truncatedKeys = entries.length - 60;
  }
  return output;
}

function createSessionId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

function normalizeLevel(level) {
  const normalized = String(level || "info").toLowerCase();
  return ["debug", "info", "warn", "error", "fatal"].includes(normalized)
    ? normalized
    : "info";
}

function truncate(value, limit) {
  const text = String(value || "");
  return text.length <= limit ? text : `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]`;
}

module.exports = {
  createLogger,
  createSessionId,
  rotateLog,
  summarizeValue
};
