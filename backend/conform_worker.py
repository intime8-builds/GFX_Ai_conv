"""AI conform worker used by the Electron shell.

The worker never writes beside the source plate or track. It decodes to float,
does a conservative temporal denoise, applies the public 3DE radial model,
performs the configured OCIO display transform, and safely publishes outputs.
"""

from __future__ import annotations

import concurrent.futures
import itertools
import json
import math
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, BinaryIO, Iterator

import numpy as np
import PyOpenColorIO as ocio

os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
try:
    import cv2
except ImportError:
    cv2 = None


CHILDREN: list[subprocess.Popen[Any]] = []
CANCELLED = False
CANCEL_PATH: Path | None = None
TV_LIMIT_BYTES = 64 * 1024 * 1024
OCIO_THREADS = max(1, min(16, os.cpu_count() or 4))
OCIO_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=OCIO_THREADS)
DECODE_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=1)
MAP_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=min(4, OCIO_THREADS))


def emit(kind: str, **values: Any) -> None:
    payload = {"type": kind, **values}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(message: str) -> int:
    emit("error", message=message)
    return 1


def request_cancel(_signum: int, _frame: Any) -> None:
    global CANCELLED
    CANCELLED = True
    for child in tuple(CHILDREN):
        terminate(child)


def check_cancelled() -> None:
    cancel_file_exists = False
    if CANCEL_PATH is not None:
        try:
            cancel_file_exists = CANCEL_PATH.exists()
        except OSError:
            pass
    if CANCELLED or cancel_file_exists:
        raise RuntimeError("Конвертация остановлена.")


def start_process(
    command: list[str],
    *,
    stdin: Any = None,
    stdout: Any = None,
    stderr: Any = subprocess.PIPE,
) -> subprocess.Popen[Any]:
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    process = subprocess.Popen(
        command,
        stdin=stdin,
        stdout=stdout,
        stderr=stderr,
        creationflags=flags,
    )
    CHILDREN.append(process)
    return process


def finish_process(process: subprocess.Popen[Any]) -> None:
    if process in CHILDREN:
        CHILDREN.remove(process)


def terminate(process: subprocess.Popen[Any]) -> None:
    if process.poll() is not None:
        finish_process(process)
        return
    try:
        process.terminate()
        process.wait(timeout=2)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass
    finish_process(process)


def evaluate_curve(keys: list[dict[str, float]], frame: float) -> float:
    if frame <= keys[0]["frame"]:
        return float(keys[0]["value"])
    if frame >= keys[-1]["frame"]:
        return float(keys[-1]["value"])
    for left, right in zip(keys, keys[1:]):
        if frame <= right["frame"]:
            amount = (frame - left["frame"]) / (right["frame"] - left["frame"])
            return float(left["value"] + ((right["value"] - left["value"]) * amount))
    return float(keys[-1]["value"])


def parameters_at(track: dict[str, Any], frame: float) -> dict[str, float]:
    parameters = {key: float(value) for key, value in track["parameters"].items()}
    for name, keys in track.get("curves", {}).items():
        parameters[name] = evaluate_curve(keys, frame)
    return parameters


def beam_inverse_target(
    target_x: np.ndarray,
    target_y: np.ndarray,
    parameters: dict[str, float],
) -> tuple[np.ndarray, np.ndarray]:
    phi = parameters["phiCylindricDirection"]
    q = math.sqrt(1 + parameters["bCylindricBending"])
    cosine = math.cos(phi)
    sine = math.sin(phi)
    h00 = ((cosine * cosine) / q) + ((sine * sine) * q)
    h01 = (q - (1 / q)) * cosine * sine
    h11 = ((cosine * cosine) * q) + ((sine * sine) / q)
    return (h11 * target_x) - (h01 * target_y), (-h01 * target_x) + (h00 * target_y)


def invert_radial(
    target_x: np.ndarray,
    target_y: np.ndarray,
    parameters: dict[str, float],
) -> tuple[np.ndarray, np.ndarray]:
    x = target_x.astype(np.float32, copy=True)
    y = target_y.astype(np.float32, copy=True)
    c2 = parameters["distortionDegree2"]
    c4 = parameters["distortionDegree4"]
    u2 = parameters["uDegree2"]
    u4 = parameters["uDegree4"]
    v2 = parameters["vDegree2"]
    v4 = parameters["vDegree4"]

    for _iteration in range(8):
        r2 = (x * x) + (y * y)
        radial = 1 + (c2 * r2) + (c4 * r2 * r2)
        u = u2 + (u4 * r2)
        v = v2 + (v4 * r2)
        a = (3 * x * x) + (y * y)
        b = 2 * x * y
        c = (x * x) + (3 * y * y)
        mapped_x = (x * radial) + (a * u) + (b * v)
        mapped_y = (y * radial) + (c * v) + (b * u)
        error_x = mapped_x - target_x
        error_y = mapped_y - target_y
        radial_x = (2 * c2 * x) + (4 * c4 * x * r2)
        radial_y = (2 * c2 * y) + (4 * c4 * y * r2)
        u_x = 2 * u4 * x
        u_y = 2 * u4 * y
        v_x = 2 * v4 * x
        v_y = 2 * v4 * y
        j00 = radial + (x * radial_x) + (6 * x * u) + (a * u_x) + (2 * y * v) + (b * v_x)
        j01 = (x * radial_y) + (2 * y * u) + (a * u_y) + (2 * x * v) + (b * v_y)
        j10 = (y * radial_x) + (2 * x * v) + (c * v_x) + (2 * y * u) + (b * u_x)
        j11 = radial + (y * radial_y) + (6 * y * v) + (c * v_y) + (2 * x * u) + (b * u_y)
        determinant = (j00 * j11) - (j01 * j10)
        safe = np.abs(determinant) > 1e-10
        delta_x = np.zeros_like(x)
        delta_y = np.zeros_like(y)
        delta_x[safe] = ((error_x[safe] * j11[safe]) - (error_y[safe] * j01[safe])) / determinant[safe]
        delta_y[safe] = ((j00[safe] * error_y[safe]) - (j10[safe] * error_x[safe])) / determinant[safe]
        x -= delta_x
        y -= delta_y
    return x, y


def make_remap(
    job: dict[str, Any],
    parameters: dict[str, float],
) -> tuple[np.ndarray, np.ndarray]:
    canvas = job["canvas"]
    base_width = int(canvas["baseWidth"])
    base_height = int(canvas["baseHeight"])
    output_width = int(canvas["width"])
    output_height = int(canvas["height"])
    left = float(canvas["left"])
    top = float(canvas["top"])

    output_x = ((np.arange(output_width, dtype=np.float32) + 0.5 + left) / base_width)[None, :]
    map_x = np.empty((output_height, output_width), dtype=np.float32)
    map_y = np.empty((output_height, output_width), dtype=np.float32)
    filmback_width = parameters["filmbackWidth"]
    filmback_height = parameters["filmbackHeight"]
    radius = math.hypot(filmback_width / 2, filmback_height / 2)
    stripe_rows = 128

    def process_rows(bounds: tuple[int, int]) -> None:
        row, end = bounds
        output_y = 1 - (
            (np.arange(row, end, dtype=np.float32)[:, None] + 0.5 + top) / base_height
        )
        full_x = parameters["fovXa"] + (output_x * (parameters["fovXb"] - parameters["fovXa"]))
        full_y = parameters["fovYa"] + (output_y * (parameters["fovYb"] - parameters["fovYa"]))
        target_x = (
            (full_x * filmback_width) - parameters["lensCenterOffsetX"] - (filmback_width / 2)
        ) / radius
        target_y = (
            (full_y * filmback_height) - parameters["lensCenterOffsetY"] - (filmback_height / 2)
        ) / radius
        target_x, target_y = np.broadcast_arrays(target_x, target_y)
        target_x, target_y = beam_inverse_target(target_x, target_y, parameters)
        distorted_x, distorted_y = invert_radial(target_x, target_y, parameters)
        distorted_full_x = (
            (distorted_x * radius) + parameters["lensCenterOffsetX"] + (filmback_width / 2)
        ) / filmback_width
        distorted_full_y = (
            (distorted_y * radius) + parameters["lensCenterOffsetY"] + (filmback_height / 2)
        ) / filmback_height
        distorted_unit_x = (distorted_full_x - parameters["fovXa"]) / (
            parameters["fovXb"] - parameters["fovXa"]
        )
        distorted_unit_y = (distorted_full_y - parameters["fovYa"]) / (
            parameters["fovYb"] - parameters["fovYa"]
        )
        map_x[row:end] = (distorted_unit_x * base_width) - 0.5
        map_y[row:end] = ((1 - distorted_unit_y) * base_height) - 0.5

    ranges = [
        (row, min(output_height, row + stripe_rows))
        for row in range(0, output_height, stripe_rows)
    ]
    list(MAP_EXECUTOR.map(process_rows, ranges))
    return map_x, map_y


def remap_bilinear(
    frame: np.ndarray,
    map_x: np.ndarray,
    map_y: np.ndarray,
) -> np.ndarray:
    if cv2 is not None:
        return cv2.remap(
            frame,
            map_x,
            map_y,
            interpolation=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        )

    source_height, source_width, _channels = frame.shape
    output = np.zeros((map_x.shape[0], map_x.shape[1], 3), dtype=np.float32)
    stripe_rows = 128

    for row in range(0, map_x.shape[0], stripe_rows):
        end = min(map_x.shape[0], row + stripe_rows)
        x = map_x[row:end]
        y = map_y[row:end]
        valid = (x >= 0) & (x <= source_width - 1) & (y >= 0) & (y <= source_height - 1)
        clipped_x = np.clip(x, 0, source_width - 1)
        clipped_y = np.clip(y, 0, source_height - 1)
        x0 = np.floor(clipped_x).astype(np.int32)
        y0 = np.floor(clipped_y).astype(np.int32)
        x1 = np.minimum(x0 + 1, source_width - 1)
        y1 = np.minimum(y0 + 1, source_height - 1)
        wx = (clipped_x - x0)[..., None]
        wy = (clipped_y - y0)[..., None]
        top = (frame[y0, x0] * (1 - wx)) + (frame[y0, x1] * wx)
        bottom = (frame[y1, x0] * (1 - wx)) + (frame[y1, x1] * wx)
        sampled = (top * (1 - wy)) + (bottom * wy)
        sampled[~valid] = 0
        output[row:end] = sampled
    return output


def temporal_denoise(
    previous: np.ndarray,
    current: np.ndarray,
    following: np.ndarray,
    strength: float,
) -> np.ndarray:
    if strength <= 0:
        return current

    output = np.empty_like(current)
    stripe_rows = 128
    for row in range(0, current.shape[0], stripe_rows):
        end = min(current.shape[0], row + stripe_rows)
        current_stripe = current[row:end]
        neighbour_average = (previous[row:end] + following[row:end]) * 0.5
        delta = neighbour_average - current_stripe
        threshold = 0.0125 * (1 + np.abs(current_stripe))
        confidence = np.exp(-np.square(delta / np.maximum(threshold, 1e-6)))
        output[row:end] = current_stripe + ((0.22 * strength) * confidence * delta)
    return output


def source_dimensions(job: dict[str, Any]) -> tuple[int, int]:
    media = job["plate"].get("media") or {}
    width = int(media.get("width") or job["canvas"]["baseWidth"])
    height = int(media.get("height") or job["canvas"]["baseHeight"])
    if width <= 0 or height <= 0:
        raise RuntimeError("Не удалось определить исходное разрешение plate.")
    return width, height


def processing_canvas(job: dict[str, Any]) -> dict[str, Any]:
    canvas = job["canvas"]
    source_width, source_height = source_dimensions(job)
    scale_x = source_width / float(canvas["baseWidth"])
    scale_y = source_height / float(canvas["baseHeight"])
    return {
        "baseWidth": source_width,
        "baseHeight": source_height,
        "width": max(1, int(round(float(canvas["width"]) * scale_x))),
        "height": max(1, int(round(float(canvas["height"]) * scale_y))),
        "left": float(canvas["left"]) * scale_x,
        "top": float(canvas["top"]) * scale_y,
    }


def resize_frame(frame: np.ndarray, width: int, height: int) -> np.ndarray:
    if frame.shape[1] == width and frame.shape[0] == height:
        return frame
    if cv2 is not None:
        return cv2.resize(frame, (width, height), interpolation=cv2.INTER_LANCZOS4)

    source_height, source_width, _channels = frame.shape
    x = (((np.arange(width, dtype=np.float32) + 0.5) * source_width) / width) - 0.5
    y = (((np.arange(height, dtype=np.float32) + 0.5) * source_height) / height) - 0.5
    map_x, map_y = np.meshgrid(x, y)
    return remap_bilinear(frame, map_x, map_y)


def create_ocio_processor(job: dict[str, Any]) -> Any:
    config = ocio.Config.CreateFromFile(job["ocio"]["configPath"])
    input_space = job["inputColorSpace"]
    if config.getColorSpace(input_space) is None:
        raise RuntimeError(f"В OCIO config нет colorspace '{input_space}'.")
    transform = ocio.DisplayViewTransform()
    transform.setSrc(input_space)
    transform.setDisplay(job["ocio"]["display"])
    transform.setView(job["ocio"]["view"])
    return config.getProcessor(transform).getDefaultCPUProcessor()


def apply_ocio(image: np.ndarray, processor: Any) -> np.ndarray:
    rgba = np.ones((image.shape[0], image.shape[1], 4), dtype=np.float32)
    rgba[:, :, :3] = image
    chunks = np.array_split(rgba, min(OCIO_THREADS, image.shape[0]), axis=0)
    list(OCIO_EXECUTOR.map(processor.applyRGBA, chunks))
    return rgba


def read_exact(stream: BinaryIO, size: int) -> bytes | bytearray:
    payload = bytearray(size)
    view = memoryview(payload)
    offset = 0
    while offset < size:
        count = stream.readinto(view[offset:])
        if not count:
            break
        offset += count
    view.release()
    if offset == size:
        return payload
    return bytes(payload[:offset])


def raw_frames(stream: BinaryIO, width: int, height: int) -> Iterator[np.ndarray]:
    frame_size = width * height * 3 * 4
    while True:
        check_cancelled()
        payload = read_exact(stream, frame_size)
        if not payload:
            return
        if len(payload) != frame_size:
            raise RuntimeError("FFmpeg вернул неполный float-кадр.")
        planes = np.frombuffer(payload, dtype="<f4").reshape((3, height, width))
        packed = np.empty((height, width, 3), dtype=np.float32)
        packed[:, :, 0] = planes[2]
        packed[:, :, 1] = planes[0]
        packed[:, :, 2] = planes[1]
        yield packed


def exr_sequence_frames(job: dict[str, Any]) -> Iterator[np.ndarray]:
    if cv2 is None:
        raise RuntimeError("OpenCV недоступен для прямого чтения EXR.")

    plate = job["plate"]
    start = int(plate["startNumber"])
    end = int(plate["endNumber"])
    pattern = plate["inputPath"]
    for frame_number in range(start, end + 1):
        check_cancelled()
        frame_path = pattern % frame_number
        if os.name == "nt":
            # cv2.imread still uses a narrow path on Windows. Reading the
            # compressed payload first keeps Cyrillic and other Unicode paths intact.
            encoded = np.fromfile(frame_path, dtype=np.uint8)
            image = cv2.imdecode(encoded, cv2.IMREAD_UNCHANGED) if encoded.size else None
        else:
            image = cv2.imread(frame_path, cv2.IMREAD_UNCHANGED)
        if image is None:
            raise RuntimeError(f"OpenCV не прочитал EXR-кадр: {frame_path}")
        if image.ndim == 2:
            image = np.repeat(image[:, :, None], 3, axis=2)
        if image.shape[2] < 3:
            raise RuntimeError(f"В EXR-кадре меньше трёх каналов: {frame_path}")
        if image.dtype != np.float32:
            if np.issubdtype(image.dtype, np.integer):
                image = image.astype(np.float32) / float(np.iinfo(image.dtype).max)
            else:
                image = image.astype(np.float32)
        yield np.ascontiguousarray(image[:, :, 2::-1])


def open_source_frames(
    job: dict[str, Any],
) -> tuple[Iterator[np.ndarray], subprocess.Popen[Any] | None]:
    plate = job["plate"]
    if (
        plate.get("kind") == "sequence"
        and str(plate.get("inputPath", "")).lower().endswith(".exr")
        and cv2 is not None
    ):
        direct_frames = exr_sequence_frames(job)
        try:
            first_frame = next(direct_frames)
            return itertools.chain((first_frame,), direct_frames), None
        except Exception as error:
            sys.stderr.write(f"OpenCV EXR fallback to FFmpeg: {error}\n")

    source_width, source_height = source_dimensions(job)
    decoder = start_process(decoder_command(job), stdout=subprocess.PIPE)
    if decoder.stdout is None:
        terminate(decoder)
        raise RuntimeError("Не удалось открыть FFmpeg decoder исходного plate.")
    return raw_frames(decoder.stdout, source_width, source_height), decoder


def decoder_command(job: dict[str, Any]) -> list[str]:
    plate = job["plate"]
    command = [job["ffmpegPath"], "-hide_banner", "-loglevel", "error"]
    if plate["kind"] == "sequence":
        command.extend([
            "-framerate", str(job["fps"]),
            "-start_number", str(plate["startNumber"]),
        ])
    command.extend(["-i", plate["inputPath"]])
    command.extend([
        "-map", "0:v:0",
        "-an",
        "-pix_fmt", "gbrpf32le",
        "-f", "rawvideo",
        "pipe:1",
    ])
    return command


def encoder_command(job: dict[str, Any], output_path: Path) -> list[str]:
    canvas = job["canvas"]
    return [
        job["ffmpegPath"],
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-f", "rawvideo",
        "-pix_fmt", "gbrapf32le",
        "-video_size", f"{canvas['width']}x{canvas['height']}",
        "-framerate", str(job["fps"]),
        "-i", "pipe:0",
        "-an",
        "-c:v", "prores_ks",
        "-profile:v", "4",
        "-vendor", "apl0",
        "-pix_fmt", "yuva444p10le",
        "-color_primaries", "bt709",
        "-color_trc", "bt709",
        "-colorspace", "bt709",
        "-f", "mov",
        str(output_path),
    ]


def packed_rgba_to_planar(rgba: np.ndarray) -> bytes:
    height, width, _channels = rgba.shape
    planar = np.empty((4, height, width), dtype=np.float32)
    planar[0] = rgba[:, :, 1]
    planar[1] = rgba[:, :, 2]
    planar[2] = rgba[:, :, 0]
    planar[3] = rgba[:, :, 3]
    return planar.tobytes()


def write_encoder_frame(encoder: subprocess.Popen[Any], payload: bytes) -> None:
    if encoder.stdin is None:
        raise RuntimeError("Канал ProRes encoder недоступен.")
    try:
        encoder.stdin.write(payload)
    except BrokenPipeError as error:
        stderr = encoder.stderr.read().decode("utf8", "replace") if encoder.stderr else ""
        code = encoder.wait()
        finish_process(encoder)
        detail = brief_error(stderr) or f"FFmpeg завершился с кодом {code}."
        raise RuntimeError(f"ProRes encoder: {detail}") from error


def render_main(job: dict[str, Any], part_path: Path) -> dict[str, Any]:
    canvas = job["canvas"]
    source_width, source_height = source_dimensions(job)
    render_canvas = processing_canvas(job)
    render_job = {**job, "canvas": render_canvas}
    output_width = int(canvas["width"])
    output_height = int(canvas["height"])
    target_frames = max(1, int(round(float(job["durationSeconds"]) * float(job["fps"]))))
    processor = create_ocio_processor(job)
    track = job["track"]
    static_map: tuple[np.ndarray, np.ndarray] | None = None
    timings = {
        "decode": 0.0,
        "denoise": 0.0,
        "remap": 0.0,
        "reformat": 0.0,
        "ocio": 0.0,
        "encode": 0.0,
    }
    started = time.perf_counter()

    if not track.get("animated"):
        static_map = make_remap(render_job, parameters_at(track, 0))

    stage_started = time.perf_counter()
    frames, decoder = open_source_frames(job)
    try:
        encoder = start_process(encoder_command(job, part_path), stdin=subprocess.PIPE)
    except Exception:
        if decoder is not None:
            terminate(decoder)
        raise
    if encoder.stdin is None:
        terminate(encoder)
        if decoder is not None:
            terminate(decoder)
        raise RuntimeError("Не удалось открыть каналы FFmpeg.")

    current = next(frames, None)
    following = next(frames, None)
    timings["decode"] += time.perf_counter() - stage_started
    previous = current
    last_encoded: bytes | None = None
    encoded_count = 0
    processed_count = 0
    pending_frame: concurrent.futures.Future[np.ndarray | None] | None = None
    processing_complete = False

    try:
        while current is not None and encoded_count < target_frames:
            check_cancelled()
            if following is not None and (encoded_count + 1) < target_frames:
                pending_frame = DECODE_EXECUTOR.submit(next, frames, None)
            next_frame = following if following is not None else current
            stage_started = time.perf_counter()
            denoised = temporal_denoise(
                previous if previous is not None else current,
                current,
                next_frame,
                float(job.get("denoiseStrength", 1)),
            )
            timings["denoise"] += time.perf_counter() - stage_started
            track_start = job["plate"].get("startNumber")
            if track_start is None:
                track_start = track.get("firstCurveFrame") or 1
            frame_number = float(track_start) + encoded_count
            remap = static_map or make_remap(render_job, parameters_at(track, frame_number))
            stage_started = time.perf_counter()
            undistorted = remap_bilinear(denoised, remap[0], remap[1])
            timings["remap"] += time.perf_counter() - stage_started
            stage_started = time.perf_counter()
            reformatted = resize_frame(undistorted, output_width, output_height)
            timings["reformat"] += time.perf_counter() - stage_started
            stage_started = time.perf_counter()
            transformed = apply_ocio(reformatted, processor)
            timings["ocio"] += time.perf_counter() - stage_started
            payload = packed_rgba_to_planar(transformed)
            stage_started = time.perf_counter()
            write_encoder_frame(encoder, payload)
            timings["encode"] += time.perf_counter() - stage_started
            last_encoded = payload
            encoded_count += 1
            processed_count += 1
            emit(
                "progress",
                phase="conform",
                progress=5 + int((encoded_count / target_frames) * 73),
                frame=encoded_count,
                totalFrames=target_frames,
            )
            previous = current
            current = following
            if current is not None and pending_frame is not None:
                stage_started = time.perf_counter()
                following = pending_frame.result()
                timings["decode"] += time.perf_counter() - stage_started
                pending_frame = None
            else:
                following = None

        if current is None and decoder is not None:
            decoder_stderr = decoder.stderr.read().decode("utf8", "replace") if decoder.stderr else ""
            decoder_code = decoder.wait()
            finish_process(decoder)
            decoder = None
            if decoder_code != 0:
                raise RuntimeError(f"FFmpeg decoder: {brief_error(decoder_stderr)}")

        if last_encoded is None:
            raise RuntimeError("FFmpeg не прочитал ни одного кадра plate.")

        while encoded_count < target_frames:
            check_cancelled()
            stage_started = time.perf_counter()
            write_encoder_frame(encoder, last_encoded)
            timings["encode"] += time.perf_counter() - stage_started
            encoded_count += 1
            emit(
                "progress",
                phase="padding",
                progress=5 + int((encoded_count / target_frames) * 73),
                frame=encoded_count,
                totalFrames=target_frames,
            )
        processing_complete = True
    finally:
        if pending_frame is not None:
            pending_frame.cancel()
        try:
            encoder.stdin.close()
        except Exception:
            pass
        if decoder is not None and decoder.poll() is None:
            terminate(decoder)
        if not processing_complete:
            terminate(encoder)

    encoder_stderr = encoder.stderr.read().decode("utf8", "replace") if encoder.stderr else ""
    encoder_code = encoder.wait()
    finish_process(encoder)
    if encoder_code != 0:
        raise RuntimeError(f"ProRes encoder: {brief_error(encoder_stderr)}")
    if not part_path.is_file() or part_path.stat().st_size == 0:
        raise RuntimeError("FFmpeg не создал ProRes-файл.")

    elapsed = time.perf_counter() - started
    return {
        "backend": f"OpenCV {cv2.__version__}" if cv2 is not None else "NumPy fallback",
        "pipeline": "source denoise -> source undistort -> output reformat -> OCIO -> ProRes",
        "sourceResolution": f"{source_width}x{source_height}",
        "undistortResolution": f"{render_canvas['width']}x{render_canvas['height']}",
        "outputResolution": f"{output_width}x{output_height}",
        "processedFrames": processed_count,
        "paddedFrames": target_frames - processed_count,
        "elapsedSeconds": round(elapsed, 3),
        "processedFps": round(processed_count / elapsed, 3) if elapsed > 0 else None,
        "stageSeconds": {name: round(value, 3) for name, value in timings.items()},
    }


def run_command(command: list[str]) -> str:
    check_cancelled()
    process = start_process(command, stdout=subprocess.PIPE)
    stdout, stderr = process.communicate()
    code = process.returncode
    finish_process(process)
    if code != 0:
        raise RuntimeError(brief_error(stderr.decode("utf8", "replace")))
    return stdout.decode("utf8", "replace")


def render_topview(job: dict[str, Any], main_path: Path, part_path: Path, temp_dir: Path) -> None:
    duration = float(job["durationSeconds"])
    target_bits = int(TV_LIMIT_BYTES * 8 * 0.96)
    bitrate = max(100_000, int(target_bits / duration))
    passlog = temp_dir / "topview-pass"
    common = [
        job["ffmpegPath"],
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", str(main_path),
        "-map", "0:v:0",
        "-an",
        "-c:v", "libx264",
        "-preset", "slow",
        "-b:v", str(bitrate),
        "-maxrate", str(bitrate),
        "-bufsize", str(bitrate * 2),
        "-pix_fmt", "yuv420p",
        "-profile:v", "high",
        "-color_primaries", "bt709",
        "-color_trc", "bt709",
        "-colorspace", "bt709",
        "-passlogfile", str(passlog),
    ]
    emit("progress", phase="topview-pass-1", progress=80)
    run_command(common + ["-pass", "1", "-f", "null", "NUL" if os.name == "nt" else "/dev/null"])
    emit("progress", phase="topview-pass-2", progress=90)
    run_command(common + ["-pass", "2", "-movflags", "+faststart", "-f", "mp4", str(part_path)])
    if not part_path.is_file() or part_path.stat().st_size == 0:
        raise RuntimeError("FFmpeg не создал Topview.")
    if part_path.stat().st_size > TV_LIMIT_BYTES:
        raise RuntimeError(
            f"Topview получился больше 64 МБ: {part_path.stat().st_size / 1024 / 1024:.2f} МБ."
        )


def media_info(ffmpeg_path: str, media_path: Path) -> dict[str, Any]:
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    result = subprocess.run(
        [ffmpeg_path, "-hide_banner", "-i", str(media_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=flags,
        check=False,
    )
    text = result.stderr.decode("utf8", "replace")
    duration_match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    dimensions_match = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", text)
    codec_match = re.search(r"Video:\s*([^,\s]+)", text)
    duration = None
    if duration_match:
        duration = (
            (int(duration_match.group(1)) * 3600)
            + (int(duration_match.group(2)) * 60)
            + float(duration_match.group(3))
        )
    return {
        "path": str(media_path),
        "bytes": media_path.stat().st_size,
        "codec": codec_match.group(1) if codec_match else None,
        "width": int(dimensions_match.group(1)) if dimensions_match else None,
        "height": int(dimensions_match.group(2)) if dimensions_match else None,
        "durationSeconds": duration,
    }


def unique_outputs(output_dir: Path, shot_name: str) -> tuple[Path, Path, Path]:
    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", shot_name).strip() or "shot"
    index = 0
    while True:
        suffix = "" if index == 0 else f"_{index}"
        main = output_dir / f"{safe_name}_conform{suffix}.mov"
        topview = output_dir / f"{safe_name}_conform{suffix}_tv.mp4"
        report = output_dir / f"{safe_name}_conform{suffix}_qc.json"
        if not main.exists() and not topview.exists() and not report.exists():
            return main, topview, report
        index += 1


def brief_error(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return "\n".join(lines[-8:]) or "неизвестная ошибка FFmpeg"


def run_job(job: dict[str, Any]) -> dict[str, Any]:
    output_dir = Path(job["outputDir"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    main_path, topview_path, report_path = unique_outputs(output_dir, job["shotName"])
    main_part = main_path.with_suffix(".part.mov")
    topview_part = topview_path.with_suffix(".part.mp4")
    report_part = report_path.with_suffix(".part.json")
    partials = [main_part, topview_part, report_part]
    published: list[Path] = []
    publish_complete = False
    emit("progress", phase="preparing", progress=2)

    try:
        performance = render_main(job, main_part)
        emit("metrics", performance=performance)
        with tempfile.TemporaryDirectory(prefix="gfx-ai-conform-") as temp:
            render_topview(job, main_part, topview_part, Path(temp))
        emit("progress", phase="qc", progress=98)
        main_info = media_info(job["ffmpegPath"], main_part)
        main_info["path"] = str(main_path)
        topview_info = media_info(job["ffmpegPath"], topview_part)
        topview_info["path"] = str(topview_path)
        report = {
            "ok": True,
            "sourcePlate": job["plate"]["selectedPath"],
            "track": job["track"]["filePath"],
            "trackVersion": job["track"].get("version"),
            "inputColorSpace": job["inputColorSpace"],
            "outputColor": f"{job['ocio']['display']} / {job['ocio']['view']}",
            "fps": job["fps"],
            "durationSeconds": job["durationSeconds"],
            "canvas": job["canvas"],
            "denoiseStrength": job.get("denoiseStrength", 1),
            "performance": performance,
            "main": main_info,
            "topview": topview_info,
        }
        report_part.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")

        for partial, final in (
            (main_part, main_path),
            (topview_part, topview_path),
            (report_part, report_path),
        ):
            if final.exists():
                raise RuntimeError(f"Выходной файл уже существует: {final}")
            os.rename(partial, final)
            partials.remove(partial)
            published.append(final)
        publish_complete = True
        emit("progress", phase="done", progress=100)
        return {
            "mainPath": str(main_path),
            "topviewPath": str(topview_path),
            "reportPath": str(report_path),
            "report": report,
        }
    except Exception:
        for partial in partials:
            try:
                partial.unlink(missing_ok=True)
            except OSError:
                pass
        if not publish_complete:
            for final in published:
                try:
                    final.unlink(missing_ok=True)
                except OSError:
                    pass
        raise


def self_test() -> int:
    parameters = {
        "filmbackWidth": 3.22,
        "filmbackHeight": 1.814,
        "lensCenterOffsetX": 0,
        "lensCenterOffsetY": 0,
        "pixelAspect": 1,
        "fovXa": 0,
        "fovXb": 1,
        "fovYa": 0,
        "fovYb": 1,
        "distortionDegree2": 0,
        "uDegree2": 0,
        "vDegree2": 0,
        "distortionDegree4": 0,
        "uDegree4": 0,
        "vDegree4": 0,
        "phiCylindricDirection": 0,
        "bCylindricBending": 0,
    }
    job = {
        "canvas": {
            "baseWidth": 32,
            "baseHeight": 18,
            "width": 32,
            "height": 18,
            "left": 0,
            "top": 0,
        }
    }
    map_x, map_y = make_remap(job, parameters)
    expected_x = np.arange(32, dtype=np.float32)[None, :]
    expected_y = np.arange(18, dtype=np.float32)[:, None]
    if not np.allclose(map_x, expected_x, atol=1e-4):
        raise RuntimeError("Identity X remap failed.")
    if not np.allclose(map_y, expected_y, atol=1e-4):
        raise RuntimeError("Identity Y remap failed.")
    pipeline_job = {
        "plate": {"media": {"width": 64, "height": 36}},
        "canvas": {
            "baseWidth": 32,
            "baseHeight": 18,
            "width": 34,
            "height": 20,
            "left": -1,
            "top": -1,
        },
    }
    if processing_canvas(pipeline_job) != {
        "baseWidth": 64,
        "baseHeight": 36,
        "width": 68,
        "height": 40,
        "left": -2.0,
        "top": -2.0,
    }:
        raise RuntimeError("Source-resolution processing canvas failed.")
    sample = np.linspace(0, 1, 12 * 8 * 3, dtype=np.float32).reshape((8, 12, 3))
    expected_denoise = temporal_denoise(sample * 0.9, sample, sample * 1.1, 1)
    if not np.allclose(expected_denoise, sample, atol=1e-6):
        raise RuntimeError("Temporal denoise stripe processing failed.")
    sys.stdout.write(json.dumps({
        "ok": True,
        "numpy": np.__version__,
        "ocio": ocio.__version__,
        "opencv": cv2.__version__ if cv2 is not None else None,
    }))
    return 0


def main() -> int:
    global CANCEL_PATH
    signal.signal(signal.SIGTERM, request_cancel)
    signal.signal(signal.SIGINT, request_cancel)
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        return self_test()
    if len(sys.argv) != 2:
        return fail("usage: conform_worker.py JOB.json")
    try:
        job = json.loads(Path(sys.argv[1]).read_text(encoding="utf8"))
        CANCEL_PATH = Path(job["cancelPath"]) if job.get("cancelPath") else None
        result = run_job(job)
        emit("result", **result)
        return 0
    except Exception as error:
        return fail(str(error))
    finally:
        for child in tuple(CHILDREN):
            terminate(child)


if __name__ == "__main__":
    raise SystemExit(main())
