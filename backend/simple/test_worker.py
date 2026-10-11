import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np

from color import ColorPipeline, read_image, write_image, nuke_script
from media import discover, inspect_image, probe
from worker import Worker

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "resources/aces_1.2/config.ocio"
FFMPEG = ROOT / "node_modules/ffmpeg-static/ffmpeg.exe"
FFPROBE = ROOT / "node_modules/ffprobe-static/ffprobe.exe"


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="gfx-simple-")
        self.root = Path(self.temporary.name) / "Тест с пробелом"
        self.root.mkdir()
        self.output = self.root / "output"
        self.output.mkdir()
        self.worker = Worker(argparse.Namespace(config=CONFIG, ffmpeg=FFMPEG, ffprobe=FFPROBE, cancel=""))

    def tearDown(self):
        self.worker.stop_children()
        self.temporary.cleanup()

    def sequence(self, count=6, alpha=False):
        directory = self.root / "plate"
        directory.mkdir()
        pixels = np.zeros((48, 64, 4 if alpha else 3), np.float32)
        pixels[:, :, :3] = [0.18, 0.12, 0.08]
        if alpha:
            pixels[:, :, 3] = 0.5
        for i in range(count):
            write_image(directory / f"plate.{1001+i}.exr", pixels, "ACES - ACEScg")
        return discover([str(directory)], FFPROBE)["sources"][0]

    def payload(self, source, **changes):
        settings = {"direction": "ai", "inputFps": 24, "inputColorSpace": "ACES - ACEScg", "outputDir": str(self.output)}
        settings.update(changes)
        return {"source": source, "settings": settings, "colorConfirmed": True}

    def test_unicode_exr_and_forward(self):
        source = self.sequence()
        self.assertEqual(source["frameCount"], 6)
        self.assertEqual(source["startFrame"], 1001)
        self.assertEqual(source["width"], 64)
        result = self.worker.run(self.payload(source))
        actual = probe(result["outputPath"], FFPROBE)
        self.assertEqual(actual["codec"], "h264")
        self.assertEqual(actual["pixelFormat"], "yuv420p")
        self.assertEqual(actual["frameCount"], 6)
        self.assertAlmostEqual(actual["duration"], 0.25, places=3)
        self.assertEqual(actual["colorSpace"], "Output - Rec.709")

    def test_copy_and_nuke_handoff(self):
        source = self.sequence()
        first = self.worker.run(self.payload(source))
        video = discover([first["outputPath"]], FFPROBE)["sources"][0]
        result = self.worker.run(self.payload(video, direction="nuke", inputColorSpace="Output - Rec.709"))
        self.assertEqual(result["method"], "copy")
        self.assertEqual(Path(first["outputPath"]).read_bytes(), Path(result["outputPath"]).read_bytes())
        script = Path(result["nukePath"]).read_text(encoding="utf-8")
        self.assertIn('OCIO_config aces_1.2', script)
        self.assertIn('raw false', script)
        self.assertIn('in_colorspace {Output - Rec.709}', script)
        self.assertNotIn(str(self.root), script)

    def test_gaps_block_without_padding(self):
        source = self.sequence()
        Path(source["files"][2]).unlink()
        source = discover([str(Path(source["path"]).parent)], FFPROBE)["sources"][0]
        self.assertEqual(source["gaps"], [1003])
        with self.assertRaises(ValueError):
            self.worker.run(self.payload(source))
        self.assertFalse(list(self.output.iterdir()))

    def test_alpha_requires_explicit_flatten(self):
        source = self.sequence(alpha=True)
        with self.assertRaisesRegex(ValueError, "alpha"):
            self.worker.run(self.payload(source))
        result = self.worker.run(self.payload(source, flattenAlpha=True))
        self.assertTrue(Path(result["outputPath"]).is_file())

    def test_png_frame_and_preview(self):
        source = self.sequence()
        result = self.worker.run(self.payload(source, exportKind="png", frameIndex=2))
        self.assertEqual(inspect_image(Path(result["outputPath"]))["width"], 64)
        preview = self.payload(source)
        preview["previewPath"] = str(self.output / "preview.png")
        self.assertTrue(Path(self.worker.preview(preview)["path"]).is_file())

    def test_native_exr_preserves_pixels_and_numbering(self):
        source = self.sequence()
        result = self.worker.run(self.payload(source, direction="nuke"))
        copied = sorted(Path(result["outputPath"]).glob("*.exr"))
        self.assertEqual(len(copied), 6)
        self.assertTrue(copied[0].name.endswith("001001.exr"))
        self.assertEqual(Path(source["files"][0]).read_bytes(), copied[0].read_bytes())

    def test_color_chain_agrees_with_direct_transform(self):
        color = ColorPipeline(CONFIG)
        pixels = np.array([[[0.01, 0.01, 0.01], [0.18, 0.12, 0.08], [0.6, 0.4, 0.2]]], np.float32)
        encoded = color.transform(pixels.copy(), "ACES - ACEScg", "Output - Rec.709")
        recovered = color.transform(encoded.copy(), "Output - Rec.709", "ACES - ACEScg")
        repeated = color.transform(recovered, "ACES - ACEScg", "Output - Rec.709")
        self.assertLess(float(np.max(np.abs(repeated - encoded))), 1/255)


if __name__ == "__main__":
    unittest.main()
