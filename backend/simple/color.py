"""Explicit ACES 1.2 display conversion and Nuke handoff."""
import hashlib
import json
from pathlib import Path

import numpy as np
import OpenImageIO as oiio
import PyOpenColorIO as ocio


class ColorPipeline:
    def __init__(self, path):
        self.path = Path(path)
        self.config = ocio.Config.CreateFromFile(str(self.path))
        self.config.validate()
        self.spaces = list(self.config.getColorSpaceNames())
        self.processors = {}
        self.fingerprint = hashlib.sha256(self.path.read_bytes()).hexdigest()
        bundle = self.path.parent / "bundle.json"
        self.bundle = json.loads(bundle.read_text(encoding="utf-8")) if bundle.exists() else {}

    def info(self):
        priority = ["ACES - ACES2065-1", "ACES - ACEScg", "Output - Rec.709", "Output - sRGB"]
        return {"spaces": priority + [s for s in self.spaces if s not in priority],
                "defaultSpace": priority[0], "configLabel": "ACES 1.2 / ACEScg / sRGB (ACES)",
                "fingerprint": self.fingerprint, "revision": self.bundle.get("revision")}

    def transform(self, pixels, source, destination):
        if source not in self.spaces or destination not in self.spaces:
            raise ValueError("Неизвестный colorspace. Выберите пространство из списка ACES 1.2.")
        output = np.ascontiguousarray(pixels, dtype=np.float32)
        if not np.isfinite(output).all():
            raise ValueError("Изображение содержит NaN/Inf. Исправьте исходные значения перед конвертацией.")
        if source != destination:
            key = (source, destination)
            if key not in self.processors:
                self.processors[key] = self.config.getProcessor(source, destination).getDefaultCPUProcessor()
            if output.shape[-1] == 4:
                self.processors[key].applyRGBA(output)
            else:
                self.processors[key].applyRGB(output)
        if not np.isfinite(output).all():
            raise ValueError("Цветовое преобразование вернуло NaN/Inf.")
        return output


def read_image(path):
    reader = oiio.ImageInput.open(str(path))
    if not reader:
        raise ValueError(f"Не удалось прочитать {path}: {oiio.geterror()}")
    try:
        spec = reader.spec()
        if spec.deep:
            raise ValueError("Deep EXR не поддерживается.")
        names = list(spec.channelnames)
        channels = [names.index(c) for c in ("R", "G", "B")]
        if "A" in names:
            channels.append(names.index("A"))
        pixels = reader.read_image(format=oiio.FLOAT)
        if pixels is None:
            raise ValueError(reader.geterror() or "Не удалось декодировать EXR/PNG.")
        pixels = np.ascontiguousarray(pixels[:, :, channels], dtype=np.float32)
        width, height = spec.full_width or spec.width, spec.full_height or spec.height
        full_x, full_y = spec.full_x, spec.full_y
        if (spec.x, spec.y, spec.width, spec.height) != (full_x, full_y, width, height):
            canvas = np.zeros((height, width, len(channels)), dtype=np.float32)
            x, y = spec.x - full_x, spec.y - full_y
            left, top, right, bottom = max(x, 0), max(y, 0), min(x + spec.width, width), min(y + spec.height, height)
            if right > left and bottom > top:
                canvas[top:bottom, left:right] = pixels[top-y:bottom-y, left-x:right-x]
            pixels = canvas
        return pixels
    finally:
        reader.close()


def display_pixels(pixels, pipeline, source, destination, flatten=False):
    alpha = pixels[:, :, 3:4] if pixels.shape[-1] == 4 else None
    rgb = np.array(pixels[:, :, :3], dtype=np.float32, order="C")
    # EXR/PNG readers deliver associated alpha; transforms operate on straight RGB.
    if alpha is not None:
        rgb = np.divide(rgb, alpha, out=np.zeros_like(rgb), where=alpha > 1e-8)
    rgb = pipeline.transform(rgb, source, destination)
    if alpha is not None:
        if flatten:
            return np.ascontiguousarray(rgb * alpha)
        return np.ascontiguousarray(np.concatenate([rgb * alpha, alpha], axis=2))
    return rgb


def write_image(path, pixels, color_space, half=False):
    is_png = Path(path).suffix.lower() == ".png"
    data_type = oiio.UINT16 if is_png else (oiio.HALF if half else oiio.FLOAT)
    spec = oiio.ImageSpec(pixels.shape[1], pixels.shape[0], pixels.shape[2], data_type)
    spec.channelnames = ["R", "G", "B", "A"][:pixels.shape[2]]
    spec.attribute("oiio:ColorSpace", color_space)
    if not is_png:
        spec.attribute("compression", "zip")
    output = oiio.ImageOutput.create(str(path))
    if not output or not output.open(str(path), spec):
        raise ValueError(oiio.geterror() or "Не удалось создать изображение.")
    try:
        if not output.write_image(pixels):
            raise ValueError(output.geterror())
    finally:
        output.close()


def nuke_quote(value):
    # Braced Tcl strings with escaped braces cannot execute substitutions.
    text = str(value).replace("\\", "/")
    return "{" + text.replace("{", "\\{").replace("}", "\\}").replace("\n", " ").replace("\r", " ") + "}"


def nuke_script(relative_path, color_space, width, height, fps, first, last, aspect=1, has_alpha=False, straight_alpha=False, matrix=None, levels=None):
    video_knobs = ""
    if matrix:
        video_knobs = f' mov64_ycbcr_matrix "Rec {709 if matrix == "bt709" else 601}"\n mov64_decode_video_levels "{"Video Range" if levels == "tv" else "Full Range"}"\n'
    premult = '''Premult {
 name AI_Associate_Alpha
 xpos 0
 ypos 40
}
''' if straight_alpha else ""
    return f'''version 16.0 v7
Root {{
 project_directory {{[file dirname [value root.name]]}}
 first_frame {first}
 last_frame {last}
 fps {float(fps):.12g}
 format "{width} {height} 0 0 {width} {height} {aspect:.12g} GFX_AI_{width}x{height}_{aspect:.6g}"
 colorManagement OCIO
 OCIO_config aces_1.2
 workingSpaceLUT scene_linear
 monitorLut "sRGB (ACES)"
}}
Read {{
 inputs 0
 file {nuke_quote(relative_path)}
 first {first}
 last {last}
 origfirst {first}
 origlast {last}
 colorspace "Utility - Raw"
 raw false
 auto_alpha true
{video_knobs.rstrip()}
 name AI_Media
 xpos 0
 ypos 0
}}
{premult}OCIOColorSpace {{
 in_colorspace {nuke_quote(color_space)}
 out_colorspace "ACES - ACEScg"
 unpremult {"rgba.alpha" if has_alpha else "none"}
 name AI_To_ACEScg
 label "ACES 1.2: appearance mapping, not recovered source HDR"
 xpos 0
 ypos 80
}}
Viewer {{
 viewerProcess "sRGB (ACES)"
 name Viewer1
 xpos 0
 ypos 160
}}
'''
