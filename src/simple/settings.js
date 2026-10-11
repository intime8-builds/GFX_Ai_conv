"use strict";

const DEFAULTS = Object.freeze({
  schemaVersion: 1, direction: "ai", outputDir: "", inputColorSpace: "", inputFps: 24,
  outputFps: "", width: "", height: "", rangeStart: "", rangeEnd: "", exportKind: "video",
  frameIndex: 0, conversion: "preserve", flattenAlpha: false, sourceManifest: "",
  inputMatrix: "auto", inputRange: "auto"
});

function sanitizeSettings(value = {}) {
  const result = { ...DEFAULTS };
  for (const key of ["outputDir", "inputColorSpace", "sourceManifest"]) {
    if (typeof value[key] === "string" && value[key].length <= 32767) result[key] = value[key];
  }
  for (const key of ["inputFps", "outputFps", "width", "height", "rangeStart", "rangeEnd", "frameIndex"]) {
    const item = value[key];
    if (item === "" || item === null || item === undefined) continue;
    if ((typeof item === "string" || typeof item === "number") && String(item).length < 32 && /^[0-9]+(?:[./][0-9]+)?$/.test(String(item))) result[key] = item;
    else throw new Error(`Некорректное значение ${key}.`);
  }
  result.direction = value.direction === "nuke" ? "nuke" : "ai";
  result.exportKind = value.exportKind === "png" ? "png" : "video";
  result.conversion = value.conversion === "exr" ? "exr" : "preserve";
  result.flattenAlpha = value.flattenAlpha === true;
  result.inputMatrix = ["bt709", "bt601", "bt2020"].includes(value.inputMatrix) ? value.inputMatrix : "auto";
  result.inputRange = ["tv", "pc"].includes(value.inputRange) ? value.inputRange : "auto";
  return result;
}

module.exports = { DEFAULTS, sanitizeSettings };
