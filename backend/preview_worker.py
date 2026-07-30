"""Render one color-managed undistorted preview frame."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import conform_worker as worker


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: preview_worker.py JOB.json OUTPUT.jpg")

    job = json.loads(Path(sys.argv[1]).read_text(encoding="utf8"))
    output_path = Path(sys.argv[2]).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas = job["canvas"]
    decoder = worker.start_process(worker.decoder_command(job), stdout=subprocess.PIPE)
    if decoder.stdout is None:
        raise RuntimeError("Не удалось открыть preview decoder.")

    frames = worker.raw_frames(
        decoder.stdout,
        int(canvas["baseWidth"]),
        int(canvas["baseHeight"]),
    )
    frame = next(frames, None)
    worker.terminate(decoder)
    if frame is None:
        raise RuntimeError("FFmpeg не прочитал preview-кадр.")

    track = job["track"]
    frame_number = job["plate"].get("startNumber") or track.get("firstCurveFrame") or 1
    parameters = worker.parameters_at(track, float(frame_number))
    map_x, map_y = worker.make_remap(job, parameters)
    undistorted = worker.remap_bilinear(frame, map_x, map_y)
    rgba = worker.apply_ocio(undistorted, worker.create_ocio_processor(job))
    payload = worker.packed_rgba_to_planar(rgba)
    command = [
        job["ffmpegPath"],
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-f", "rawvideo",
        "-pix_fmt", "gbrapf32le",
        "-video_size", f"{canvas['width']}x{canvas['height']}",
        "-framerate", str(job["fps"]),
        "-i", "pipe:0",
        "-frames:v", "1",
        "-vf", "scale=640:-2:flags=lanczos",
        "-q:v", "3",
        str(output_path),
    ]
    process = worker.start_process(command, stdin=subprocess.PIPE)
    _stdout, stderr = process.communicate(input=payload)
    code = process.returncode
    worker.finish_process(process)
    if code != 0:
        raise RuntimeError(worker.brief_error(stderr.decode("utf8", "replace")))
    sys.stdout.write(json.dumps({"path": str(output_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        sys.stderr.write(str(error))
        raise SystemExit(1)
