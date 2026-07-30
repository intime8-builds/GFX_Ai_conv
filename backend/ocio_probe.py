"""Read the color-space menu from the OCIO config shipped with Nuke."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import PyOpenColorIO as ocio


def choose_display_view(config: ocio.Config) -> tuple[str, str]:
    displays = list(config.getDisplays())
    preferred_displays = (
        "Rec.1886 Rec.709 - Display",
        "sRGB - Display",
    )
    display = next((item for item in preferred_displays if item in displays), displays[0])
    views = list(config.getViews(display))
    view = next(
        (item for item in views if "SDR 100 nits (Rec.709)" in item),
        views[0],
    )
    return display, view


def priority(name: str) -> tuple[int, str]:
    preferred = {
        "ACES2065-1": 0,
        "ACEScg": 1,
        "ACEScct": 2,
        "ACEScc": 3,
        "sRGB Encoded Rec.709 (sRGB)": 4,
        "Rec.1886 Encoded Rec.709": 5,
    }
    return preferred.get(name, 100), name.casefold()


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: ocio_probe.py CONFIG.ocio")

    config_path = Path(sys.argv[1]).resolve()
    config = ocio.Config.CreateFromFile(str(config_path))
    color_spaces = sorted(list(config.getColorSpaceNames()), key=priority)
    display, view = choose_display_view(config)
    result = {
        "configPath": str(config_path),
        "ocioVersion": ocio.__version__,
        "colorSpaces": color_spaces,
        "defaultInput": "ACES2065-1" if "ACES2065-1" in color_spaces else color_spaces[0],
        "display": display,
        "view": view,
    }
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
