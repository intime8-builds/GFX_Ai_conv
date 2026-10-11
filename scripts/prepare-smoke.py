"""Create local synthetic integration fixtures; never reads production media."""
import argparse
import json
import os
from pathlib import Path
import sys
import subprocess

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend/simple"))
import numpy as np
from color import display_pixels, write_image, read_image
from media import discover, image_source
from worker import Worker

out = ROOT / "output/smoke"
out.mkdir(parents=True, exist_ok=True)
ffmpeg = ROOT / "node_modules/ffmpeg-static/ffmpeg.exe"
ffprobe = ROOT / "node_modules/ffprobe-static/ffprobe.exe"
video = out / "Тест video 23.976.mov"
subprocess.run([str(ffmpeg), "-hide_banner", "-v", "error", "-f", "lavfi", "-i",
    "testsrc2=size=640x360:rate=24000/1001:duration=5", "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
    "-c:v", "libx264", "-crf", "16", "-c:a", "aac", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-colorspace", "bt709", "-y", str(video)], check=True)
worker = Worker(argparse.Namespace(config=ROOT / "resources/aces_1.2/config.ocio", ffmpeg=ffmpeg, ffprobe=ffprobe, cancel=""))
cases = []
for extension in ("exr", "png"):
    pixels = np.zeros((32, 32, 4), np.float32)
    pixels[:, :, :] = [0.4, 0.15, 0.05, 0.5]
    path = out / f"alpha.{extension}"
    write_image(path, pixels, "Output - sRGB")
    source = discover([str(path)], ffprobe)["sources"][0]
    result = worker.run({"source": source, "settings": {"direction": "nuke", "outputDir": str(out), "inputColorSpace": "Output - sRGB"}, "colorConfirmed": True})
    expected = display_pixels(pixels.copy(), worker.color, "Output - sRGB", "ACES - ACEScg")[16, 16].tolist()
    cases.append({"kind": extension, "script": result["nukePath"], "frame": 1, "x": 16, "y": 16, "expected": expected, "tolerance": 0.0001})
source = discover([str(video)], ffprobe)["sources"][0]
result = worker.run({"source": source, "settings": {"direction": "nuke", "outputDir": str(out), "inputColorSpace": "Output - Rec.709"}, "colorConfirmed": True})
pixels = worker.decode_frame(source, 0)
expected = display_pixels(pixels, worker.color, "Output - Rec.709", "ACES - ACEScg")[100, 100].tolist() + [1]
cases.append({"kind": "mp4", "script": result["nukePath"], "frame": 1, "x": 100, "y": 259, "expected": expected, "tolerance": 0.015})
real_plate = os.environ.get("GFX_SIMPLE_TEST_PLATE")
if real_plate:
    # An explicitly supplied single plate is read only; all derivatives stay local.
    source = image_source([Path(real_plate)], [1001])
    payload = {"source": source, "settings": {"direction": "nuke", "outputDir": str(out),
        "inputColorSpace": "Output - Rec.709"}, "colorConfirmed": True}
    result = worker.run(payload)
    pixels = display_pixels(read_image(real_plate), worker.color, "Output - Rec.709", "ACES - ACEScg")
    for x, y in [(source["width"]//2, source["height"]//2), (source["width"]//3, source["height"]//3)]:
        expected = pixels[y, x].tolist()
        if len(expected) == 3:
            expected.append(1)
        cases.append({"kind": "real-plate", "script": result["nukePath"], "frame": 1001, "x": x,
            "y": source["height"]-1-y, "expected": expected, "tolerance": 0.0001})
    payload["settings"]["direction"] = "ai"
    payload["settings"]["flattenAlpha"] = True
    worker.run(payload)
(out / "nuke-cases.json").write_text(json.dumps(cases, indent=2), encoding="utf-8")
(out / "fixtures.json").write_text(json.dumps({"video": str(video), "output": str(out / "results")}, ensure_ascii=False), encoding="utf-8")
(out / "results").mkdir(exist_ok=True)
print("SMOKE_FIXTURES_READY")
