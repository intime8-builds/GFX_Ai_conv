"""Read-only media discovery. Container extensions never establish color."""
import hashlib
import json
import math
from fractions import Fraction
from pathlib import Path
import re
import struct
import subprocess

import OpenImageIO as oiio

VIDEO_EXTENSIONS = {".mp4", ".mov"}
IMAGE_EXTENSIONS = {".exr", ".png"}
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def rational(value, fallback="24/1"):
    try:
        result = Fraction(str(value))
        if result <= 0 or result > 1000:
            raise ValueError("Invalid fps")
        return result
    except (ValueError, ZeroDivisionError, TypeError):
        return Fraction(fallback)


def packet_timing(path, ffprobe, video):
    result = subprocess.run([str(ffprobe), "-v", "error", "-select_streams", "v:0",
        "-show_packets", "-show_entries", "packet=pts,duration,flags", "-of", "compact=p=0", str(path)],
        capture_output=True, encoding="utf-8", errors="replace", timeout=120, creationflags=NO_WINDOW)
    if result.returncode or result.stderr.strip():
        raise ValueError("Повреждённый видеопоток: " + result.stderr.strip()[-2000:])
    stamps = []
    for line in result.stdout.splitlines():
        fields = dict(field.split("=", 1) for field in line.split("|") if "=" in field)
        if "C" in fields.get("flags", ""):
            raise ValueError("Видеопоток содержит повреждённый пакет.")
        if "pts" not in fields:
            continue
        if fields["pts"] == "N/A":
            raise ValueError("Не определено время видеокадров.")
        stamps.append(int(fields["pts"]))
    declared = video.get("nb_frames")
    if not stamps or (declared not in (None, "N/A") and int(declared) != len(stamps)):
        raise ValueError("Число видеопакетов не совпадает с заявленным числом кадров. Возможно, файл обрезан.")
    stamps.sort()
    timebase = Fraction(video["time_base"])
    nominal = rational(video.get("r_frame_rate"), str(rational(video.get("avg_frame_rate"))))
    step = 1 / nominal / timebase
    # CFR may alternate adjacent integer ticks, e.g. 23.976 in a millisecond timebase.
    allowed_steps = {math.floor(step), math.ceil(step)}
    variable = any((b - a) not in allowed_steps for a, b in zip(stamps, stamps[1:]))
    digest = hashlib.sha256()
    for stamp in stamps:
        digest.update(f"{(stamp - stamps[0]) * timebase};".encode("ascii"))
    return {"packetFrameCount": len(stamps), "suspectedVfr": variable,
            "timestampSha256": digest.hexdigest(), "timingChecked": True}


def probe(path, ffprobe):
    completed = subprocess.run(
        [str(ffprobe), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True, encoding="utf-8", errors="replace", timeout=120,
        creationflags=NO_WINDOW)
    if completed.returncode:
        raise ValueError(completed.stderr.strip() or "Не удалось прочитать видео.")
    data = json.loads(completed.stdout)
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"
                  and not s.get("disposition", {}).get("attached_pic")), None)
    if video is None:
        raise ValueError("В файле нет видеопотока.")
    fps = rational(video.get("avg_frame_rate") or video.get("r_frame_rate"))
    duration = float(video.get("duration") or data.get("format", {}).get("duration") or 0)
    if duration <= 0:
        raise ValueError("Не удалось определить длительность видео.")
    transfer = video.get("color_transfer", "unknown")
    primaries = video.get("color_primaries", "unknown")
    matrix = video.get("color_space", "unknown")
    hdr = transfer in {"smpte2084", "arib-std-b67"} or primaries == "bt2020"
    known = transfer == "bt709" and primaries == "bt709" and matrix == "bt709"
    color = "Output - Rec.709" if known else ""
    if transfer == "iec61966-2-1" and primaries == "bt709":
        color = "Output - sRGB"
    rotation = next((float(x["rotation"]) for x in video.get("side_data_list", [])
                     if "rotation" in x), 0)
    width, height = int(video["width"]), int(video["height"])
    if abs(rotation) % 180 == 90:
        width, height = height, width
    warnings = []
    if hdr:
        warnings.append("HDR: выберите точное входное пространство; автоматического SDR-преобразования нет.")
    if not color:
        warnings.append("Цвет не подтверждён метаданными. Укажите входной colorspace.")
    nominal = rational(video.get("r_frame_rate"), str(fps))
    timing = packet_timing(path, ffprobe, video)
    return {
        "kind": "video", "width": width, "height": height,
        "codedWidth": int(video["width"]), "codedHeight": int(video["height"]),
        "fps": float(fps), "fpsRational": str(fps), "duration": duration,
        "frameCount": timing["packetFrameCount"],
        "startFrame": 1, "codec": video.get("codec_name"),
        "pixelFormat": video.get("pix_fmt", ""), "colorSpace": color,
        "suggestedColorSpace": color or ("" if hdr else "Output - Rec.709"),
        "needsColorConfirmation": not bool(color), "hasAlpha": "a" in video.get("pix_fmt", "")
        and video.get("pix_fmt", "").startswith(("yuva", "rgba", "bgra", "gbrap")),
        "warnings": warnings, "hdr": hdr, "rotation": rotation,
        "sampleAspectRatio": video.get("sample_aspect_ratio", "1:1"),
        "colorMatrix": matrix, "colorRange": video.get("color_range", "unknown"),
        **timing,
        "metadata": data,
    }


def inspect_image(path):
    reader = oiio.ImageInput.open(str(path))
    if not reader:
        raise ValueError(f"Не удалось прочитать изображение: {oiio.geterror()}")
    try:
        spec = reader.spec()
        if spec.deep:
            raise ValueError("Deep EXR не поддерживается. Нужен обычный RGB/RGBA EXR.")
        channels = list(spec.channelnames)
        if not all(c in channels for c in ("R", "G", "B")):
            raise ValueError("Нет базовых каналов R/G/B. Экспортируйте beauty RGB/RGBA.")
        if reader.seek_subimage(1, 0):
            raise ValueError("Multipart EXR требует предварительного выбора beauty-part в Nuke.")
        color = str(spec.getattribute("oiio:ColorSpace") or "")
        aces_flag = spec.getattribute("acesImageContainerFlag")
        if aces_flag == 1:
            color = "ACES - ACES2065-1"
        aliases = {"ACEScg": "ACES - ACEScg", "ACES2065-1": "ACES - ACES2065-1",
                   "sRGB": "Output - sRGB", "srgb": "Output - sRGB"}
        color = aliases.get(color, color)
        # Generic 'linear' does not specify the primaries.
        if not color.startswith(("ACES -", "Output -", "Input -", "Utility -")):
            color = ""
        return {"width": spec.full_width or spec.width, "height": spec.full_height or spec.height,
                "channels": channels, "hasAlpha": "A" in channels,
                "colorSpace": color, "suggestedColorSpace": color or ("Output - sRGB" if path.suffix.lower() == ".png" else "ACES - ACES2065-1"),
                "needsColorConfirmation": not bool(color), "pixelFormat": str(spec.format),
                "dataWindow": [spec.x, spec.y, spec.width, spec.height],
                "displayWindow": [spec.full_x, spec.full_y, spec.full_width, spec.full_height]}
    finally:
        reader.close()


def sequence_groups(directory):
    groups = {}
    singles = []
    entries = sorted(directory.iterdir())
    if len(entries) > 100000:
        raise ValueError("В папке больше 100 000 файлов. Выберите отдельную папку последовательности.")
    for entry in entries:
        if not entry.is_file() or entry.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        match = re.match(r"^(.*?)(\d+)(\.[^.]+)$", entry.name)
        if match:
            key = (match[1], len(match[2]), match[3].lower())
            groups.setdefault(key, []).append((int(match[2]), entry))
        else:
            singles.append([entry])
    return [sorted(items) for items in groups.values()], singles


def identify(source):
    path = Path(source["path"])
    stat = path.stat()
    identity = f"{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}|{source.get('frameCount')}"
    source.update(id=hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24], name=path.name)
    source["fileStats"] = [{"path": str(p), "size": p.stat().st_size, "mtimeNs": str(p.stat().st_mtime_ns)}
                           for p in map(Path, source.get("files", [source["path"]]))]
    return source


def image_source(files, numbers=None):
    source = inspect_image(files[0])
    source.update(path=str(files[0].resolve()), files=[str(f.resolve()) for f in files],
                  kind="sequence" if len(files) > 1 else "image", codec=files[0].suffix[1:].lower(),
                  frameCount=len(files), startFrame=numbers[0] if numbers else 1,
                  endFrame=numbers[-1] if numbers else len(files), fps=24, fpsRational="24",
                  duration=len(files) / 24, warnings=[])
    if numbers:
        expected = numbers[-1] - numbers[0] + 1
        if expected != len(numbers):
            present = set(numbers)
            source["gaps"] = [n for n in range(numbers[0], min(numbers[-1] + 1, numbers[0] + 100000))
                              if n not in present][:100]
            source["error"] = "В последовательности пропущены кадры. Автозаполнение отключено."
    if source["needsColorConfirmation"]:
        source["warnings"].append("Входной colorspace предполагается: подтвердите или измените его.")
    if source["hasAlpha"]:
        source["warnings"].append("Есть alpha. Для MP4 подтвердите сведение на чёрный фон.")
    return identify(source)


def discover(paths, ffprobe):
    sources, errors, seen = [], [], set()
    for raw in paths:
        path = Path(raw).resolve()
        try:
            candidates = []
            if path.is_dir() or path.suffix.lower() in IMAGE_EXTENSIONS:
                directory = path if path.is_dir() else path.parent
                groups, singles = sequence_groups(directory)
                for group in groups:
                    if path.is_dir() or any(p == path for _, p in group):
                        candidates.append((list(p for _, p in group), list(n for n, _ in group)))
                for files in singles:
                    if path.is_dir() or path in files:
                        candidates.append((files, None))
                if not candidates:
                    raise ValueError("Не найдены EXR/PNG изображения или последовательности.")
                for files, numbers in candidates:
                    try:
                        source = image_source(files, numbers)
                        if source["id"] not in seen:
                            sources.append(source)
                            seen.add(source["id"])
                    except Exception as error:
                        errors.append({"path": str(files[0]), "message": str(error)})
            elif path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS:
                source = identify(dict(probe(path, ffprobe), path=str(path)))
                if source["id"] not in seen:
                    sources.append(source)
                    seen.add(source["id"])
            else:
                raise ValueError("Поддерживаются MOV, MP4, EXR и PNG.")
        except Exception as error:
            errors.append({"path": str(path), "message": str(error)})
    return {"sources": sources, "errors": errors}


def is_faststart(path):
    with Path(path).open("rb") as stream:
        size = Path(path).stat().st_size
        while stream.tell() < size:
            header = stream.read(8)
            if len(header) < 8:
                return False
            length, kind = struct.unpack(">I4s", header)
            head_size = 8
            if length == 1:
                extra = stream.read(8)
                if len(extra) != 8:
                    return False
                length = struct.unpack(">Q", extra)[0]
                head_size = 16
            if kind == b"moov":
                return True
            if kind == b"mdat" or length < head_size:
                return False
            stream.seek(length - head_size, 1)
    return False
