"""One bounded job per process; JSONL is the only stdout protocol."""
import argparse
from collections import deque
from datetime import datetime, timezone
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid

import numpy as np
import OpenImageIO as oiio

from color import ColorPipeline, display_pixels, nuke_script, read_image, write_image
from media import NO_WINDOW, discover, inspect_image, is_faststart, probe, rational

PROFILE = {"id": "universal-sdr-v1", "version": 1, "encoder": "libx264", "crf": 16,
           "preset": "medium", "pixelFormat": "yuv420p", "colorSpace": "Output - Rec.709"}


def emit(kind, **values):
    print(json.dumps({"type": kind, **values}, ensure_ascii=False), flush=True)


class Worker:
    def __init__(self, args):
        self.args = args
        self.color = ColorPipeline(args.config)
        self.active = []
        self.cancel_path = Path(args.cancel) if args.cancel else None
        self.last_progress = 0
        self.max_percent = 0

    def check_cancel(self):
        if self.cancel_path and self.cancel_path.exists():
            raise InterruptedError("Обработка остановлена.")

    def progress(self, percent, phase="conversion", **extra):
        self.check_cancel()
        now = time.monotonic()
        if now - self.last_progress >= 0.15 or percent >= 100:
            self.max_percent = max(self.max_percent, min(100, max(0, percent)))
            emit("progress", percent=round(self.max_percent, 2), phase=phase, **extra)
            self.last_progress = now

    def spawn(self, args, **kwargs):
        process = subprocess.Popen([str(self.args.ffmpeg), "-hide_banner", "-nostdin", "-v", "warning", "-xerror", "-err_detect", "explode",
                                    *[str(a) for a in args]], creationflags=NO_WINDOW, **kwargs)
        self.active.append(process)
        return process

    def stop_children(self):
        for process in self.active:
            if process.poll() is None:
                process.kill()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream and not stream.closed:
                    stream.close()
        self.active.clear()

    def run_ffmpeg(self, arguments, duration=1):
        process = self.spawn([*arguments, "-progress", "pipe:1", "-nostats"],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             encoding="utf-8", errors="replace")
        errors = deque(maxlen=80)
        reader = threading.Thread(target=lambda: errors.extend(process.stderr), daemon=True)
        reader.start()
        for line in process.stdout:
            self.check_cancel()
            if line.startswith("out_time_us="):
                try:
                    self.progress(float(line.split("=", 1)[1]) / 1e6 / max(duration, 0.001) * 95)
                except ValueError:
                    pass
        code = process.wait()
        reader.join(timeout=5)
        if code:
            raise RuntimeError("FFmpeg: " + "".join(errors)[-10000:])

    def copy(self, source, target, start=0, span=90):
        size = source.stat().st_size
        digest = hashlib.sha256()
        with source.open("rb") as src, target.open("xb") as dst:
            total = 0
            while chunk := src.read(4 * 1024 * 1024):
                self.check_cancel()
                dst.write(chunk)
                digest.update(chunk)
                total += len(chunk)
                self.progress(start + span * total / max(size, 1), "copy")
        with target.open("rb") as copied:
            if hashlib.file_digest(copied, "sha256").hexdigest() != digest.hexdigest():
                raise RuntimeError("Проверка SHA-256 копии не пройдена.")
        return digest.hexdigest()

    def validate(self, payload):
        source = dict(payload["source"])
        settings = dict(payload.get("settings") or {})
        if source.get("error"):
            raise ValueError(source["error"])
        input_path = Path(source["path"])
        if not input_path.is_file():
            raise ValueError("Исходный файл недоступен.")
        self.check_sources(source)
        space = str(settings.get("inputColorSpace") or source.get("colorSpace") or source.get("suggestedColorSpace") or "")
        if space not in self.color.spaces:
            raise ValueError("Укажите входной colorspace.")
        if source.get("needsColorConfirmation") and not payload.get("colorConfirmed"):
            raise ValueError("Подтвердите предполагаемый входной colorspace.")
        settings["inputColorSpace"] = space
        for name in ("width", "height"):
            if settings.get(name) not in ("", None, 0):
                number = float(settings[name])
                if not number.is_integer() or not 2 <= number <= 16384:
                    raise ValueError("Размер должен быть целым числом от 2 до 16384.")
                settings[name] = int(number)
        for name in ("inputFps", "outputFps"):
            if settings.get(name) not in ("", None):
                try:
                    rate = Fraction(str(settings[name]))
                    if not 0 < rate <= 240:
                        raise ValueError()
                except (ValueError, ZeroDivisionError):
                    raise ValueError("FPS должен быть больше 0 и не больше 240.")
        direction = settings.get("direction", "ai")
        if direction not in ("ai", "nuke"):
            raise ValueError("Неизвестное направление конвертации.")
        return source, settings

    def check_sources(self, source):
        for item in source.get("fileStats", []):
            self.check_cancel()
            stat = Path(item["path"]).stat()
            if stat.st_size != item["size"] or stat.st_mtime_ns != int(item["mtimeNs"]):
                raise ValueError("Исходник изменился после добавления в очередь. Добавьте его заново.")

    def aspect(self, source):
        value = source.get("sampleAspectRatio", "1:1").replace(":", "/")
        return float(rational(value, "1"))

    def geometry(self, source, settings):
        original_w, original_h = int(source["width"]), int(source["height"])
        w, h = settings.get("width"), settings.get("height")
        if not w and not h:
            return original_w, original_h
        original_w *= self.aspect(source)
        width = int(w or (round(int(h) * original_w / original_h) if h else original_w))
        height = int(h or (round(int(w) * original_h / original_w) if w else original_h))
        return width, height

    def selection(self, source, settings):
        fps = rational(settings.get("inputFps") or 24) if source["kind"] != "video" else rational(source["fpsRational"])
        duration = source["frameCount"] / float(fps) if source["kind"] != "video" else source["duration"]
        start = float(settings.get("rangeStart") or 0)
        end = float(settings["rangeEnd"]) if settings.get("rangeEnd") not in (None, "") else duration
        if not all(math.isfinite(v) for v in (start, end)) or start < 0 or end <= start or end > duration + 0.001:
            raise ValueError(f"Некорректный диапазон. Длительность исходника: {duration:.6g} сек.")
        output_fps = rational(settings.get("outputFps"), str(fps)) if settings.get("outputFps") else fps
        return fps, output_fps, start, min(end, duration)

    def decode_parameters(self, source, settings):
        matrix = settings.get("inputMatrix", "auto")
        if matrix == "auto":
            matrix = {"bt709": "bt709", "smpte170m": "bt601", "bt470bg": "bt601",
                      "bt2020nc": "bt2020", "bt2020ncl": "bt2020", "gbr": "bt709"}.get(source.get("colorMatrix"))
        if not matrix:
            space = settings["inputColorSpace"]
            if space in ("Output - Rec.709", "Output - sRGB"):
                matrix = "bt709"
            elif "Rec.2020" in space:
                matrix = "bt2020"
            else:
                raise ValueError("Нет тегов YUV-матрицы. Выберите матрицу явно в настройках.")
        if matrix not in ("bt709", "bt601", "bt2020"):
            raise ValueError("Неизвестная матрица YUV.")
        levels = settings.get("inputRange", "auto")
        if levels == "auto":
            levels = source.get("colorRange")
            if levels not in ("tv", "pc"):
                levels = "pc" if source.get("pixelFormat", "").startswith(("rgb", "gbr", "yuvj")) else "tv"
        if levels not in ("tv", "pc"):
            raise ValueError("Неизвестный диапазон уровней.")
        return matrix, levels

    def decode_filter(self, source, settings, output_matrix=None):
        matrix, levels = self.decode_parameters(source, settings)
        pixel_format = source.get("pixelFormat", "")
        high_bit_yuv = pixel_format.startswith("yuv") and pixel_format.endswith(tuple(
            f"p{depth}{order}" for depth in (10, 12, 14, 16) for order in ("le", "be")))
        if output_matrix is None and high_bit_yuv:
            # swscale lowers high-bit YUV white; zscale needs integer RGB to keep alpha full-range.
            matrix = {"bt709": "709", "bt601": "170m", "bt2020": "2020_ncl"}[matrix]
            rgb = "gbrap16le" if source.get("hasAlpha") else "gbrp16le"
            return f"zscale=matrixin={matrix}:rangein={levels}:matrix=gbr:range=pc,format={rgb}"
        return f"scale=in_color_matrix={matrix}:in_range={levels}:out_range={'tv' if output_matrix else 'pc'}" + (f":out_color_matrix={output_matrix}" if output_matrix else "")

    def video_filters(self, source, settings, fps=None, decoded_rgb=False):
        width, height = self.geometry(source, settings)
        filters = []
        if source["kind"] == "video" and not decoded_rgb:
            filters.append(self.decode_filter(source, settings, "bt709"))
            filters.append("setparams=colorspace=bt709:range=limited")
            filters.append("format=yuv444p16le")
        aspect = self.aspect(source)
        if settings.get("width") or settings.get("height"):
            ratio = min(width / (source["width"] * aspect), height / source["height"])
            fitted_w, fitted_h = max(1, round(source["width"] * aspect * ratio)), max(1, round(source["height"] * ratio))
            filters += [f"scale={fitted_w}:{fitted_h}:flags=lanczos",
                        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black"]
            aspect = 1
        filters += ["pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:black", f"setsar={aspect:.12g}"]
        if fps:
            filters.append(f"fps={fps}")
        filters += ["scale=out_color_matrix=bt709:out_range=tv", "format=yuv420p"]
        return ",".join(filters)

    def encoder(self):
        return ["-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p",
                "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
                "-color_range", "tv", "-movflags", "+faststart"]

    def decode_frame(self, source, frame_index, settings=None):
        if frame_index < 0 or frame_index >= source["frameCount"]:
            raise ValueError("Индекс кадра выходит за пределы исходника.")
        if source["kind"] != "video":
            return read_image(source["files"][frame_index])
        # select is frame-accurate even for variable frame rate inputs.
        settings = settings or {"inputColorSpace": source.get("colorSpace") or source.get("suggestedColorSpace")}
        channels = 4 if source.get("hasAlpha") else 3
        process = self.spawn(["-i", source["path"], "-vf", f"select=eq(n\\,{frame_index}),{self.decode_filter(source, settings)}",
                              "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gbrapf32le" if channels == 4 else "gbrpf32le", "pipe:1"],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        data, error = process.communicate(timeout=120)
        if process.returncode:
            raise ValueError(error.decode("utf-8", "replace")[-4000:])
        expected = source["width"] * source["height"] * channels * 4
        if len(data) != expected:
            raise ValueError("Не удалось декодировать выбранный кадр.")
        return self.unpack_video(data, source, channels)

    def unpack_video(self, data, source, channels):
        planes = np.frombuffer(data, dtype="<f4").reshape(channels, source["height"], source["width"])
        pixels = np.ascontiguousarray(planes[[2, 0, 1] + ([3] if channels == 4 else [])].transpose(1, 2, 0))
        if channels == 4:
            pixels[:, :, :3] *= pixels[:, :, 3:4]
        return pixels

    def preview(self, payload):
        source, settings = self.validate(payload)
        pixels = self.decode_frame(source, int(settings.get("frameIndex") or 0), settings)
        pixels = display_pixels(pixels, self.color, settings["inputColorSpace"], "Output - sRGB", flatten=True)
        height, width = pixels.shape[:2]
        if self.aspect(source) != 1:
            pixels = resize_fit(pixels, max(1, round(width * self.aspect(source))), height, self.aspect(source))
            height, width = pixels.shape[:2]
        if width > 960 or height > 540:
            ratio = min(960 / width, 540 / height)
            src = oiio.ImageBuf(np.ascontiguousarray(pixels))
            resized = oiio.ImageBufAlgo.resize(src, roi=oiio.ROI(0, max(1, round(width * ratio)), 0, max(1, round(height * ratio)), 0, 1, 0, 3))
            pixels = resized.get_pixels(oiio.FLOAT)
        target = Path(payload["previewPath"])
        target.parent.mkdir(parents=True, exist_ok=True)
        write_image(target, np.clip(pixels, 0, 1), "Output - sRGB")
        return {"path": str(target), "width": pixels.shape[1], "height": pixels.shape[0]}

    def streamed_encode(self, source, settings, target, input_fps, output_fps, start, end):
        source_width, source_height = source["width"], source["height"]
        duration = end - start
        normalize_vfr = source["kind"] == "video" and source.get("suspectedVfr")
        if normalize_vfr and not settings.get("outputFps"):
            raise ValueError("Для цветового пересчёта VFR явно задайте выходной FPS. Без этого время не меняется.")
        pipe_fps = output_fps if normalize_vfr else input_fps
        raw_args = ["-f", "rawvideo", "-pix_fmt", "rgb48le", "-video_size", f"{source_width}x{source_height}",
                    "-framerate", str(pipe_fps), "-i", "pipe:0"]
        if source["kind"] == "video":
            raw_args += ["-ss", str(start), "-i", source["path"], "-map", "0:v:0", "-map", "1:a:0?",
                         "-c:a", "aac", "-b:a", "192k"]
        else:
            raw_args += ["-an"]
        args = raw_args + ["-vf", self.video_filters(source, settings, output_fps if output_fps != pipe_fps else None, decoded_rgb=True),
                           *self.encoder(), "-t", str(duration), "-n", str(target)]
        errors = deque(maxlen=80)
        encoder = self.spawn(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        error_reader = threading.Thread(target=lambda: errors.extend(encoder.stderr), daemon=True)
        error_reader.start()
        decoder = None
        try:
            if source["kind"] == "video":
                channels = 4 if source.get("hasAlpha") else 3
                filters = self.decode_filter(source, settings)
                if normalize_vfr:
                    filters += f",fps={output_fps}"
                decoder = self.spawn(["-ss", str(start), "-i", source["path"], "-t", str(duration),
                                      "-map", "0:v:0", "-vf", filters, "-fps_mode", "passthrough", "-pix_fmt",
                                      "gbrapf32le" if channels == 4 else "gbrpf32le", "-f", "rawvideo", "pipe:1"],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                frames = max(1, round(duration * float(pipe_fps)))
                def pixel_frames():
                    size = source_width * source_height * channels * 4
                    while True:
                        data = decoder.stdout.read(size)
                        if not data:
                            break
                        if len(data) != size:
                            raise ValueError("Неполный декодированный кадр.")
                        yield self.unpack_video(data, source, channels)
            else:
                first = int(math.floor(start * float(input_fps) + 1e-7))
                last = min(source["frameCount"], int(math.ceil(end * float(input_fps) - 1e-7)))
                frames = last - first
                def pixel_frames():
                    for file in source["files"][first:last]:
                        yield read_image(file)
            written = 0
            for pixels in pixel_frames():
                self.check_cancel()
                if pixels.shape[:2] != (source_height, source_width):
                    raise ValueError("Размеры кадров последовательности различаются.")
                rgb = display_pixels(pixels, self.color, settings["inputColorSpace"], "Output - Rec.709", flatten=True)
                encoder.stdin.write((np.clip(rgb, 0, 1) * 65535 + 0.5).astype("<u2").tobytes())
                written += 1
                self.progress(written / max(frames, 1) * 93, frame=written, frames=frames)
            encoder.stdin.close()
            if decoder and decoder.wait() != 0:
                raise RuntimeError("Ошибка декодирования исходного видео.")
            if start == 0 and abs(end - source["duration"]) < 0.001 and not normalize_vfr and written != source["frameCount"]:
                raise RuntimeError("Декодированы не все исходные кадры.")
            code = encoder.wait()
            error_reader.join(timeout=5)
            if code or written == 0:
                raise RuntimeError("FFmpeg: " + b"".join(errors).decode("utf-8", "replace")[-6000:])
        except BrokenPipeError:
            raise RuntimeError("FFmpeg: " + b"".join(errors).decode("utf-8", "replace")[-6000:])

    def forward(self, source, settings, stage):
        space = settings["inputColorSpace"]
        input_fps, output_fps, start, end = self.selection(source, settings)
        warnings = []
        if settings.get("exportKind") == "png":
            pixels = self.decode_frame(source, int(settings.get("frameIndex") or 0), settings)
            pixels = display_pixels(pixels, self.color, space, "Output - sRGB")
            w, h = self.geometry(source, settings)
            if (w, h) != (pixels.shape[1], pixels.shape[0]):
                pixels = resize_fit(pixels, w, h, self.aspect(source))
            target = stage / "frame.png"
            write_image(target, np.clip(pixels, 0, 1), "Output - sRGB")
            return target, "png", {"frameCount": 1, "fpsRational": str(output_fps), "colorSpace": "Output - sRGB"}, warnings
        if source.get("hasAlpha") and not settings.get("flattenAlpha"):
            raise ValueError("MP4 не сохраняет alpha. Подтвердите сведение на чёрный фон.")
        target = stage / "video.mp4"
        changed = any(settings.get(k) not in (None, "", 0) for k in ("width", "height", "outputFps", "rangeStart", "rangeEnd"))
        changed = changed or settings.get("inputMatrix", "auto") != "auto" or settings.get("inputRange", "auto") != "auto"
        can_copy = source["kind"] == "video" and source["codec"] == "h264" and source["pixelFormat"] == "yuv420p" and space == source.get("colorSpace") == "Output - Rec.709" and not changed
        audio = [s for s in source.get("metadata", {}).get("streams", []) if s.get("codec_type") == "audio"]
        can_copy = can_copy and all(s.get("codec_name") == "aac" for s in audio)
        if can_copy:
            if Path(source["path"]).suffix.lower() == ".mp4" and is_faststart(source["path"]):
                digest = self.copy(Path(source["path"]), target)
                return target, "copy", {"sha256": digest}, warnings
            self.run_ffmpeg(["-i", source["path"], "-map", "0:v:0", "-map", "0:a?", "-c", "copy",
                             "-movflags", "+faststart", "-n", target], end - start)
            return target, "remux", {}, warnings
        requested_w, requested_h = self.geometry(source, settings)
        if requested_w % 2 or requested_h % 2:
            warnings.append("Для yuv420p нечётный размер дополнен до чётного чёрным краем, без обрезки.")
        if source["kind"] == "video" and space == "Output - Rec.709" and not source.get("hasAlpha"):
            self.run_ffmpeg(["-ss", str(start), "-i", source["path"], "-t", str(end - start),
                             "-map", "0:v:0", "-map", "0:a:0?",
                             "-vf", self.video_filters(source, settings, output_fps if settings.get("outputFps") else None),
                             *self.encoder(), "-fps_mode", "cfr" if settings.get("outputFps") else "passthrough",
                             "-c:a", "aac", "-b:a", "192k", "-n", target], end - start)
        else:
            self.streamed_encode(source, settings, target, input_fps, output_fps, start, end)
        return target, "encode", {"inputFps": str(input_fps), "rangeSeconds": [start, end]}, warnings

    def handoff(self, source, settings, stage):
        space = settings["inputColorSpace"]
        path = Path(source["path"])
        fps = rational(source["fpsRational"]) if source["kind"] == "video" else rational(settings.get("inputFps") or 24)
        first, last = source.get("startFrame", 1), source.get("startFrame", 1) + source["frameCount"] - 1
        warnings, extra = [], {}
        relative, method = "", "copy"
        if source["kind"] != "video":
            files = source["files"]
            image_dir = stage / "frames"
            image_dir.mkdir()
            hashes = []
            for i, file in enumerate(files):
                pixels = read_image(file)
                if pixels.shape[:2] != (source["height"], source["width"]):
                    raise ValueError("Размеры кадров последовательности различаются.")
                del pixels
                target = image_dir / f"frame.{first+i:06d}{Path(file).suffix.lower()}"
                hashes.append(self.copy(Path(file), target, i / len(files) * 90, 90 / len(files)))
            relative = f"frames/frame.%06d{path.suffix.lower()}" if len(files) > 1 else f"frames/frame.{first:06d}{path.suffix.lower()}"
            extra["frameHashes"] = hashes
            target = image_dir
        elif settings.get("conversion") == "exr":
            if source.get("suspectedVfr"):
                raise ValueError("VFR не имеет однозначного соответствия кадрам Nuke. Сначала подготовьте CFR с явно выбранным FPS в режиме Для AI.")
            image_dir = stage / "frames"
            image_dir.mkdir()
            channels = 4 if source.get("hasAlpha") else 3
            decoder = self.spawn(["-i", path, "-map", "0:v:0", "-an", "-vf", self.decode_filter(source, settings),
                "-fps_mode", "passthrough", "-pix_fmt", "gbrapf32le" if channels == 4 else "gbrpf32le",
                "-f", "rawvideo", "pipe:1"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            count = 0
            size = source["width"] * source["height"] * channels * 4
            while data := decoder.stdout.read(size):
                self.check_cancel()
                if len(data) != size:
                    raise ValueError("Неполный декодированный кадр.")
                count += 1
                pixels = self.unpack_video(data, source, channels)
                write_image(image_dir / f"frame.{count:06d}.exr", pixels, space)
                self.progress(count / source["frameCount"] * 93)
            if decoder.wait() != 0 or count != source["frameCount"]:
                raise RuntimeError("Декодированы не все исходные кадры. Результат не опубликован.")
            files = sorted(image_dir.glob("*.exr"))
            if not files:
                raise RuntimeError("FFmpeg не создал EXR-кадры.")
            first, last = 1, len(files)
            target, relative, method = image_dir, "frames/frame.%06d.exr", "decode-exr"
            warnings.append("EXR содержит декодированное изображение AI, не восстановленный исходный HDR. Звук остаётся в исходном видео.")
        else:
            if source.get("suspectedVfr"):
                raise ValueError("Обнаружен возможный VFR. Автоматическая раскладка по кадрам Nuke отключена; подготовьте CFR явно.")
            if source.get("hdr") or source["pixelFormat"] not in {"yuv420p", "yuv422p10le", "yuv444p10le", "yuv444p12le", "yuva444p10le", "yuva444p12le"}:
                raise ValueError("Этот HDR/пиксельный формат не входит в проверяемый видеопрофиль Nuke. Выберите декодирование в EXR и точный colorspace.")
            if source["codec"] == "h264" and source["pixelFormat"] == "yuv420p":
                target = stage / "video.mp4"
                if path.suffix.lower() == ".mp4":
                    extra["sha256"] = self.copy(path, target)
                else:
                    self.run_ffmpeg(["-i", path, "-map", "0:v:0", "-map", "0:a?", "-c", "copy",
                                     "-movflags", "+faststart", "-n", target], source["duration"])
                    method = "remux"
            elif source["codec"] == "prores" and path.suffix.lower() == ".mov":
                target = stage / "video.mov"
                extra["sha256"] = self.copy(path, target)
            else:
                raise ValueError("Кодек не входит в видеопрофиль Nuke. Выберите декодирование в EXR без нового видеосжатия.")
            relative = target.name
        matrix, levels = self.decode_parameters(source, settings) if source["kind"] == "video" and method != "decode-exr" else (None, None)
        if matrix == "bt2020":
            raise ValueError("Для матрицы Rec.2020 выберите явное декодирование в EXR для Nuke.")
        straight_alpha = source.get("hasAlpha") and (source["kind"] == "video" and method != "decode-exr" or path.suffix.lower() == ".png")
        script = nuke_script(relative, space, source["width"], source["height"], fps, first, last, self.aspect(source),
                             source.get("hasAlpha", False), straight_alpha, matrix, levels)
        (stage / "open_in_nuke.nk").write_text(script, encoding="utf-8")
        extra.update(fpsRational=str(fps), firstFrame=first, lastFrame=last, colorSpace=space)
        warnings.append(".nk рассчитан на ACES 1.2 / ACEScg / sRGB (ACES). Он не меняет настройки других проектов Nuke.")
        return target, method, extra, warnings

    def run(self, payload):
        self.max_percent = 0
        source, settings = self.validate(payload)
        output = Path(settings.get("outputDir") or "").resolve()
        if not settings.get("outputDir") or not output.is_dir():
            raise ValueError("Сначала выберите существующую папку вывода.")
        self.check_cancel()
        job_id = uuid.uuid4().hex[:10]
        stage = output / f".gfx-partial-{job_id}"
        stage.mkdir(exist_ok=False)
        stem = "".join(c if c.isalnum() or c in "-_" else "_" for c in Path(source["path"]).stem)[:80]
        destination = output / f"{stem}_{settings.get('direction', 'ai')}_{job_id}"
        try:
            operation = self.handoff if settings.get("direction") == "nuke" else self.forward
            target, method, extra, warnings = operation(source, settings, stage)
            self.check_cancel()
            self.progress(96, "verify")
            actual = probe(target, self.args.ffprobe) if target.is_file() and target.suffix.lower() in {".mp4", ".mov"} else None
            if actual and method in ("copy", "remux"):
                if actual["frameCount"] != source["frameCount"] or actual["timestampSha256"] != source["timestampSha256"] or abs(actual["duration"] - source["duration"]) > 0.002:
                    raise RuntimeError("Кадры или время изменились при копировании/перепаковке.")
                self.run_ffmpeg(["-i", target, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"], actual["duration"])
            if actual and method == "encode":
                if actual["codec"] != "h264" or actual["pixelFormat"] != "yuv420p" or actual["colorSpace"] != "Output - Rec.709":
                    raise RuntimeError("Выходное видео не соответствует универсальному профилю.")
                fps_in, fps_out, start, end = self.selection(source, settings)
                expected_w, expected_h = self.geometry(source, settings)
                if (actual["width"], actual["height"]) != (expected_w + expected_w % 2, expected_h + expected_h % 2):
                    raise RuntimeError("Размер результата не прошёл проверку.")
                if abs(actual["duration"] - (end - start)) > max(0.1, 2 / float(fps_out)):
                    raise RuntimeError("Длительность результата не прошла проверку.")
                if start == 0 and abs(end - source["duration"]) < 0.001 and not settings.get("outputFps") and actual["frameCount"] != source["frameCount"]:
                    raise RuntimeError("Число кадров результата не совпало с исходником.")
            manifest = {"schemaVersion": 1, "app": "GFX Ai Conv Simple", "createdAt": datetime.now(timezone.utc).isoformat(),
                        "direction": settings.get("direction", "ai"), "profile": PROFILE,
                        "method": method, "source": source, "settings": settings,
                        "colorConfig": {"name": "ACES 1.2", "sha256": self.color.fingerprint,
                                        "bundle": self.color.bundle},
                        "output": {"relativePath": str(target.relative_to(stage)).replace("\\", "/"),
                                   "media": actual, **extra}, "warnings": warnings}
            association = settings.get("sourceManifest")
            if association:
                linked = Path(association)
                if linked.stat().st_size > 32 * 1024 * 1024:
                    raise ValueError("Слишком большой JSON исходного задания.")
                original = json.loads(linked.read_text(encoding="utf-8"))
                if original.get("schemaVersion") != 1 or original.get("app") != "GFX Ai Conv Simple":
                    raise ValueError("Выбранный JSON не является заданием этой программы.")
                manifest["sourceAssociation"] = {"path": str(linked), "createdAt": original.get("createdAt"),
                                                 "source": original.get("source"), "output": original.get("output")}
            (stage / "conversion.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            relative_target = target.relative_to(stage)
            self.check_sources(source)
            self.check_cancel()
            stage.rename(destination)
            # Publication is the commit point: a later cancellation cannot undo success.
            emit("progress", percent=100, phase="done", committed=True)
            return {"outputPath": str(destination / relative_target), "manifestPath": str(destination / "conversion.json"),
                    "nukePath": str(destination / "open_in_nuke.nk") if settings.get("direction") == "nuke" else None,
                    "warnings": warnings, "method": method, "committed": True}
        finally:
            self.stop_children()
            # Only this worker's newly created staging directory is eligible for cleanup.
            if stage.exists() and stage.parent == output and stage.name == f".gfx-partial-{job_id}":
                shutil.rmtree(stage)


def resize_fit(pixels, width, height, aspect=1):
    scale = min(width / (pixels.shape[1] * aspect), height / pixels.shape[0])
    w, h = max(1, round(pixels.shape[1] * aspect * scale)), max(1, round(pixels.shape[0] * scale))
    source = oiio.ImageBuf(np.ascontiguousarray(pixels))
    resized = oiio.ImageBufAlgo.resize(source, roi=oiio.ROI(0, w, 0, h, 0, 1, 0, pixels.shape[2])).get_pixels(oiio.FLOAT)
    canvas = np.zeros((height, width, pixels.shape[2]), dtype=np.float32)
    y, x = (height - h) // 2, (width - w) // 2
    canvas[y:y+h, x:x+w] = resized
    return canvas


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["info", "analyze", "preview", "run"])
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--ffprobe", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--cancel", default="")
    args = parser.parse_args()
    worker = None
    try:
        worker = Worker(args)
        payload = json.load(sys.stdin)
        if args.command == "info":
            result = worker.color.info()
        elif args.command == "analyze":
            result = discover(payload["paths"], args.ffprobe)
        elif args.command == "preview":
            result = worker.preview(payload)
        else:
            result = worker.run(payload)
        emit("result", result=result)
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit("error", message=str(error), cancelled=isinstance(error, InterruptedError))
        return 1
    finally:
        if worker:
            worker.stop_children()
    return 0


if __name__ == "__main__":
    sys.exit(main())
