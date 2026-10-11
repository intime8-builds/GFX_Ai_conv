# Third-Party Notices

## Simple Preview

Simple Preview bundles open-source components only; no Nuke runtime, Nuke OCIO
module, lens plugin, OpenCV, or conform-specific runtime is redistributed.

- Electron: MIT; Chromium and other dependency notices accompany Electron.
- Lucide: ISC.
- FFmpeg / ffprobe: see their bundled build and license information. The FFmpeg
  build includes GPL components (libx264). Source/build provenance must remain
  available alongside distributed binaries.
- CPython: Python Software Foundation license.
- NumPy: BSD 3-Clause, with additional bundled dependency notices.
- OpenImageIO: Apache-2.0; additional dependencies retain their own licenses.
- OpenColorIO: BSD 3-Clause.
- PyInstaller: GPL with the bootloader exception.
- ACES 1.2 configuration/LUTs: Academy of Motion Picture Arts and Sciences
  license, included in `resources/aces_1.2/LICENSE.md`. Open source snapshot:
  https://github.com/colour-science/OpenColorIO-Configs/tree/3af87f1d70ca3ea2a19cfd431b80de8014a00763/aces_1.2

## Legacy Conform Branch

The following historical notes apply to the old conform application, not the
standalone Simple Preview runtime:

GFX Ai Conv uses:

- FFmpeg through the `ffmpeg-static` npm package. The exact license and build
  information are distributed with that package.
- NumPy 2.3.4 under the BSD 3-Clause license. Its complete `LICENSE.txt` is
  distributed in `vendor/py311/numpy-2.3.4.dist-info/`.
- OpenCV Python Headless 4.12.0.88. The wrapper is distributed under the MIT
  license and OpenCV under Apache 2.0; complete notices are distributed in
  `vendor/py311/opencv_python_headless-4.12.0.88.dist-info/`.
- PyOpenColorIO and the ACES OCIO configuration from the user's local Nuke
  installation. These Nuke files are detected at runtime and are not
  redistributed with GFX Ai Conv.

The 3DE4 Radial Standard Degree 4 implementation follows the public
Science-D-Visions lens-distortion model documentation. No Nuke or 3DE4 binary
plugin is redistributed by this project.
