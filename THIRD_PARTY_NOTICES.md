# Third-Party Notices

GFX Ai Conv uses:

- FFmpeg through the `ffmpeg-static` npm package. The exact license and build
  information are distributed with that package.
- NumPy 2.3.4 under the BSD 3-Clause license. Its complete `LICENSE.txt` is
  distributed in `vendor/py311/numpy-2.3.4.dist-info/`.
- PyOpenColorIO and the ACES OCIO configuration from the user's local Nuke
  installation. These Nuke files are detected at runtime and are not
  redistributed with GFX Ai Conv.

The 3DE4 Radial Standard Degree 4 implementation follows the public
Science-D-Visions lens-distortion model documentation. No Nuke or 3DE4 binary
plugin is redistributed by this project.
