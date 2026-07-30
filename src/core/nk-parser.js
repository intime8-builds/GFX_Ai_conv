"use strict";

const fs = require("fs");
const path = require("path");

const SUPPORTED_NODE = "LD_3DE4_Radial_Standard_Degree_4";
const NUMBER_PATTERN = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";

const KNOBS = {
  tde4_filmback_width_cm: ["filmbackWidth", 3.6],
  tde4_filmback_height_cm: ["filmbackHeight", 2.4],
  tde4_lens_center_offset_x_cm: ["lensCenterOffsetX", 0],
  tde4_lens_center_offset_y_cm: ["lensCenterOffsetY", 0],
  tde4_pixel_aspect: ["pixelAspect", 1],
  field_of_view_xa_unit: ["fovXa", 0],
  field_of_view_xb_unit: ["fovXb", 1],
  field_of_view_ya_unit: ["fovYa", 0],
  field_of_view_yb_unit: ["fovYb", 1],
  Distortion_Degree_2: ["distortionDegree2", 0],
  U_Degree_2: ["uDegree2", 0],
  V_Degree_2: ["vDegree2", 0],
  Quartic_Distortion_Degree_4: ["distortionDegree4", 0],
  U_Degree_4: ["uDegree4", 0],
  V_Degree_4: ["vDegree4", 0],
  Phi_Cylindric_Direction: ["phiCylindricDirection", 0],
  B_Cylindric_Bending: ["bCylindricBending", 0]
};

function parseNkFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return {
    ...parseNkText(text),
    filePath: path.resolve(filePath)
  };
}

function parseNkText(text) {
  const body = extractNodeBody(text, SUPPORTED_NODE);
  const rawKnobs = parseNodeKnobs(body);
  const parameters = {};
  const curves = {};

  for (const [knobName, [parameterName, fallback]] of Object.entries(KNOBS)) {
    const parsed = parseAnimatedValue(rawKnobs[knobName], fallback);
    parameters[parameterName] = parsed.value;

    if (parsed.keys.length > 0) {
      curves[parameterName] = parsed.keys;
    }
  }

  validateParameters(parameters);

  const curveFrames = Array.from(new Set(
    Object.values(curves).flatMap((keys) => keys.map((key) => key.frame))
  )).sort((left, right) => left - right);

  return {
    nodeClass: SUPPORTED_NODE,
    direction: stripBraces(rawKnobs.direction || "undistort"),
    name: stripBraces(rawKnobs.name || ""),
    label: stripBraces(rawKnobs.label || ""),
    parameters,
    curves,
    animated: curveFrames.length > 0,
    curveFrames,
    firstCurveFrame: curveFrames.length > 0 ? curveFrames[0] : null,
    lastCurveFrame: curveFrames.length > 0 ? curveFrames[curveFrames.length - 1] : null
  };
}

function extractNodeBody(text, nodeClass) {
  const marker = `${nodeClass} {`;
  const start = text.indexOf(marker);

  if (start < 0) {
    throw new Error(`В .nk нет поддерживаемой ноды ${nodeClass}.`);
  }

  const braceStart = text.indexOf("{", start);
  let depth = 0;

  for (let index = braceStart; index < text.length; index += 1) {
    if (text[index] === "{") {
      depth += 1;
    } else if (text[index] === "}") {
      depth -= 1;

      if (depth === 0) {
        return text.slice(braceStart + 1, index);
      }
    }
  }

  throw new Error("Нода 3DE в .nk не закрыта фигурной скобкой.");
}

function parseNodeKnobs(body) {
  const knobs = {};
  const lines = body.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/);

    if (!match) {
      continue;
    }

    const name = match[1];
    let value = match[2];
    let balance = braceBalance(value);

    while (balance > 0 && index + 1 < lines.length) {
      index += 1;
      value += ` ${lines[index].trim()}`;
      balance += braceBalance(lines[index]);
    }

    knobs[name] = value.trim();
  }

  return knobs;
}

function braceBalance(value) {
  return (String(value).match(/{/g) || []).length - (String(value).match(/}/g) || []).length;
}

function parseAnimatedValue(rawValue, fallback) {
  if (rawValue === undefined) {
    return { value: fallback, keys: [] };
  }

  const value = String(rawValue);
  const keys = [];
  const keyPattern = new RegExp(`x(${NUMBER_PATTERN})\\s+(${NUMBER_PATTERN})`, "gi");
  let keyMatch = null;

  while ((keyMatch = keyPattern.exec(value)) !== null) {
    keys.push({
      frame: Number(keyMatch[1]),
      value: Number(keyMatch[2])
    });
  }

  keys.sort((left, right) => left.frame - right.frame);

  if (keys.length > 0) {
    return {
      value: keys[0].value,
      keys
    };
  }

  const numberMatch = value.match(new RegExp(NUMBER_PATTERN));
  return {
    value: numberMatch ? Number(numberMatch[0]) : fallback,
    keys: []
  };
}

function stripBraces(value) {
  return String(value)
    .replace(/^\{+/, "")
    .replace(/\}+$/, "")
    .trim()
    .replace(/^"(.*)"$/, "$1");
}

function validateParameters(parameters) {
  if (!(parameters.filmbackWidth > 0) || !(parameters.filmbackHeight > 0)) {
    throw new Error("В 3DE-ноду записан некорректный filmback.");
  }

  if (!(parameters.fovXb > parameters.fovXa) || !(parameters.fovYb > parameters.fovYa)) {
    throw new Error("В 3DE-ноду записан некорректный field of view.");
  }

  if (parameters.bCylindricBending <= -1) {
    throw new Error("B Cylindric Bending должен быть больше -1.");
  }
}

function evaluateTrack(track, frame) {
  const evaluated = { ...track.parameters };

  for (const [parameterName, keys] of Object.entries(track.curves || {})) {
    evaluated[parameterName] = evaluateCurve(keys, frame);
  }

  return evaluated;
}

function evaluateCurve(keys, frame) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("Нельзя вычислить пустую анимационную кривую.");
  }

  if (frame <= keys[0].frame) {
    return keys[0].value;
  }

  const last = keys[keys.length - 1];

  if (frame >= last.frame) {
    return last.value;
  }

  for (let index = 1; index < keys.length; index += 1) {
    const right = keys[index];

    if (frame <= right.frame) {
      const left = keys[index - 1];
      const amount = (frame - left.frame) / (right.frame - left.frame);
      return left.value + ((right.value - left.value) * amount);
    }
  }

  return last.value;
}

module.exports = {
  SUPPORTED_NODE,
  evaluateCurve,
  evaluateTrack,
  parseNkFile,
  parseNkText
};
