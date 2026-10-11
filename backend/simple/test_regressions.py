import hashlib
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import numpy as np

import test_worker as base
from color import read_image, nuke_script
from media import discover, probe
import worker as worker_module


FFMPEG, FFPROBE = base.FFMPEG, base.FFPROBE


class RegressionTests(unittest.TestCase):
    setUp = base.MediaTests.setUp
    tearDown = base.MediaTests.tearDown
    sequence = base.MediaTests.sequence
    payload = base.MediaTests.payload

    def ff(self, args, data=None):
        return subprocess.run([str(FFMPEG), "-v", "error", "-nostdin", *map(str, args)],
            input=data, capture_output=True, check=True, timeout=90).stdout

    def video(self, name="input.mov", extra=None, rate="24", codec="mpeg4"):
        path = self.root / name
        self.ff(["-f", "lavfi", "-i", f"testsrc2=size=64x48:rate={rate}:duration=1",
            "-c:v", codec, "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709",
            "-colorspace", "bt709", *(extra or []), "-y", path])
        return discover([str(path)], FFPROBE)["sources"][0]

    def test_fractional_fps_and_remux_audio(self):
        path = self.root / "fractional.mov"
        self.ff(["-f", "lavfi", "-i", "testsrc2=size=64x48:rate=24000/1001:duration=1",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac",
            "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709",
            "-colorspace", "bt709", "-y", path])
        source = discover([str(path)], FFPROBE)["sources"][0]
        result = self.worker.run(self.payload(source, inputColorSpace="Output - Rec.709"))
        self.assertEqual(result["method"], "remux")
        actual = probe(result["outputPath"], FFPROBE)
        self.assertEqual(actual["fpsRational"], "24000/1001")
        for stream in ("0:v:0", "0:a:0"):
            before = self.ff(["-i", path, "-map", stream, "-f", "framemd5", "-"])
            after = self.ff(["-i", result["outputPath"], "-map", stream, "-f", "framemd5", "-"])
            self.assertEqual(before, after)

    def test_video_alpha_preserved_and_flattened(self):
        path = self.root / "alpha.mov"
        pix = np.zeros((16, 16, 4), np.uint8)
        pix[:, :, 0] = 220
        pix[:, 8:, 3] = 128
        self.ff(["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "16x16", "-framerate", "24",
            "-i", "pipe:0", "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le",
            "-alpha_bits", "16", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-y", path], pix.tobytes()*6)
        source = discover([str(path)], FFPROBE)["sources"][0]
        ai = self.worker.run(self.payload(source, inputColorSpace="Output - Rec.709", flattenAlpha=True))
        actual = discover([ai["outputPath"]], FFPROBE)["sources"][0]
        decoded = self.worker.decode_frame(actual, 0)
        self.assertLess(float(decoded[8, 2].max()), 0.03)
        exr = self.worker.run(self.payload(source, direction="nuke", conversion="exr", inputColorSpace="Output - Rec.709"))
        pixels = read_image(sorted(Path(exr["outputPath"]).glob("*.exr"))[0])
        self.assertEqual(pixels.shape[2], 4)
        self.assertEqual(float(pixels[8, 2, 3]), 0)
        self.assertAlmostEqual(float(pixels[8, 12, 3]), 0.5, delta=0.01)

    def test_corrupted_container_not_published(self):
        source = self.video("complete.mp4", ["-movflags", "+faststart", "-g", "1"], codec="libx264")
        data = Path(source["path"]).read_bytes()
        mdat = data.index(b"mdat")
        damaged = self.root / "truncated.mov"
        damaged.write_bytes(data[:mdat + (len(data)-mdat)//2])
        result = discover([str(damaged)], FFPROBE)
        self.assertFalse(result["sources"])
        self.assertTrue(result["errors"])
        self.assertFalse(list(self.output.iterdir()))

    def test_explicit_untagged_matrix_matches_tagged(self):
        source = self.video()
        untagged = self.root / "untagged.mov"
        self.ff(["-i", source["path"], "-c", "copy", "-color_primaries", "unknown",
            "-color_trc", "unknown", "-colorspace", "unknown", "-y", untagged])
        second = discover([str(untagged)], FFPROBE)["sources"][0]
        results = [self.worker.run(self.payload(s, inputColorSpace="Output - Rec.709")) for s in (source, second)]
        frames = [self.worker.decode_frame(discover([r["outputPath"]], FFPROBE)["sources"][0], 0) for r in results]
        self.assertLess(float(np.max(np.abs(frames[0] - frames[1]))), 1/255)

    def test_variable_timestamps_block_nuke(self):
        path = self.root / "vfr.mp4"
        self.ff(["-f", "lavfi", "-i", "color=gray:size=16x16:rate=24", "-frames:v", "3000",
            "-vf", "setpts=PTS+gte(N\\,100)/24/TB", "-fps_mode", "vfr", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-y", path])
        source = discover([str(path)], FFPROBE)["sources"][0]
        self.assertTrue(source["suspectedVfr"])
        with self.assertRaisesRegex(ValueError, "VFR"):
            self.worker.run(self.payload(source, direction="nuke", inputColorSpace="Output - Rec.709"))

    def test_coarse_timebase_does_not_hide_vfr(self):
        path = self.root / "coarse.mp4"
        self.ff(["-f", "lavfi", "-i", "color=gray:size=16x16:rate=24", "-frames:v", "48",
            "-vf", "setpts=PTS+gte(N\\,20)/24/TB", "-fps_mode", "vfr", "-c:v", "libx264",
            "-video_track_timescale", "24", "-pix_fmt", "yuv420p", "-y", path])
        source = discover([str(path)], FFPROBE)["sources"][0]
        self.assertTrue(source["suspectedVfr"])

    def test_cancel_at_verification_does_not_publish(self):
        source = self.video("copy.mp4", ["-movflags", "+faststart"], codec="libx264")
        flag = self.root / "cancel.flag"
        self.worker.cancel_path = flag
        original = worker_module.probe
        def cancel_after(*args, **kwargs):
            result = original(*args, **kwargs)
            flag.write_text("cancel")
            return result
        with patch.object(worker_module, "probe", cancel_after), self.assertRaises(InterruptedError):
            self.worker.run(self.payload(source, inputColorSpace="Output - Rec.709"))
        self.assertFalse(list(self.output.iterdir()))

    def test_default_preserves_pixel_aspect(self):
        source = self.video(extra=["-vf", "setsar=2"])
        result = self.worker.run(self.payload(source, inputColorSpace="Output - Rec.709"))
        actual = probe(result["outputPath"], FFPROBE)
        self.assertEqual((actual["width"], actual["height"]), (64, 48))
        self.assertEqual(actual["sampleAspectRatio"], "2:1")
        self.assertIn("unpremult rgba.alpha", nuke_script("x.exr", "Output - sRGB", 64, 48, 24, 1, 5, has_alpha=True))

    def test_changed_source_requires_reanalysis(self):
        source = self.sequence()
        Path(source["files"][1]).write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "изменился"):
            self.worker.run(self.payload(source))

    def test_odd_resize_is_padded_not_cropped(self):
        source = self.video()
        result = self.worker.run(self.payload(source, width=62, inputColorSpace="Output - Rec.709"))
        actual = probe(result["outputPath"], FFPROBE)
        self.assertEqual((actual["width"], actual["height"]), (62, 46))
        result = self.worker.run(self.payload(source, width=63, height=47, inputColorSpace="Output - Rec.709"))
        actual = probe(result["outputPath"], FFPROBE)
        self.assertEqual((actual["width"], actual["height"]), (64, 48))
        self.assertTrue(result["warnings"])
