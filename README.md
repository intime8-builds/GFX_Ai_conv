# GFX Ai Conv

Local Windows converter with a small drag-and-drop interface.

## Modes

- **PNG**: converts supported image/video sources to 16-bit `.png` in an sRGB-oriented RGB output path.
- **H.264 MP4**: converts supported video sources to 10-bit H.264 High 10 `.mp4`, BT.709/sRGB-friendly color metadata, integer duration from 4 to 15 seconds, and optional 16 px dimension alignment.
- **EXR folders**: in H.264 MP4 mode, a dropped folder with numbered `.exr` files is treated as an image sequence.

FFmpeg is bundled with the app through `ffmpeg-static`.

## Saved Settings

The app saves settings automatically when you change them:

- selected mode: `PNG` or `H.264 MP4`
- output folder
- video duration
- 16 px grid option
- video quality option
- video encoder option: CPU x264 High10

Settings are stored locally at:

```text
%LOCALAPPDATA%\GFX Ai Conv\settings.json
```

Crash logs are stored at:

```text
%LOCALAPPDATA%\GFX Ai Conv\logs
```

## Queue Workflow

1. Choose an output folder.
2. Drop files or numbered EXR sequence folders into the app.
3. Check previews and queue status.
4. Press `Start`.

The queue supports:

- `Start`: begins converting queued items.
- `Pause`: pauses the queue after the current item finishes.
- `Stop`: stops the active FFmpeg process and marks waiting items as stopped.
- `Clear`: empties the queue.

Each queue item shows a preview, current status, output path or error, and percent progress.

## Local Development

```powershell
npm.cmd install
npm.cmd run dev
```

## Build Locally

```powershell
npm.cmd run dist
```

The Windows installer and unpacked zip are written to `dist/`.

## GitHub Release Build

Push a version tag to build a release automatically:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions will build the Windows installer `.exe` and unpacked `.zip`, then attach them to a GitHub Release.

## Updates

The app checks the latest GitHub Release at startup and from the update button in the header. In this first version it opens the release page for download instead of silently installing updates.

## Windows Downloads

- Use the `installer` `.exe` for normal installation. This is the recommended team build.
- If a `win.zip` build is provided, extract the whole archive to a normal folder before running `GFX Ai Conv.exe`.

Do not run `GFX Ai Conv.exe` directly from WinRAR/7-Zip preview. That launches the app from a temporary folder such as `Rar$EXa...` without all required Electron resources and can crash before the app code starts.

The Electron portable self-extracting target is intentionally not used because it can crash on some Windows systems when launched from a temporary extraction folder.

## Notes

H.264 is normally a lossy delivery codec. The default video quality is set to visually lossless CRF 16 with CPU x264 High10. A lossless H.264 option is available, but files can become much larger and may be less convenient for downstream tools.

## FAQ

### Which file should I download?

Use the `installer` `.exe` for the normal app install. This is the recommended option.

### Why is there no portable `.exe` anymore?

The Electron portable self-extracting build can crash on some Windows systems because it runs from a temporary extraction folder. The app now ships as an installer plus an unpacked zip, which is more reliable.

### Why can the zip crash when I double-click the exe inside WinRAR?

Electron apps need the executable and the `resources` folder together. Archive preview tools often launch only the selected `.exe` from a temporary folder. Extract the full archive first, or use the installer.

### Does the app stay in the tray?

Yes. Closing or minimizing the window hides it to the system tray. Use the tray menu to open the window, open the saved output folder, check updates, or quit the app completely.

### Where are converted files saved?

Converted files are saved to the output folder selected in the app. The selected folder is saved automatically and restored on the next launch.

### Does the app overwrite existing files?

No. If a file with the same output name already exists, the app adds a numeric suffix such as `_1`, `_2`, and so on.

### What does PNG mode do?

PNG mode takes the first video/image frame FFmpeg can read and writes it as 16-bit `.png` using `rgba64be`. For static image sources, this is the normal image conversion path. For video sources, it exports the first frame.

### What does H.264 MP4 mode do?

H.264 MP4 mode writes `.mp4` files with `libx264`, H.264 High 10 profile, `yuv420p10le`, BT.709 color metadata, and an sRGB transfer tag. The app loops short inputs if needed and trims the result to the selected integer duration from 4 to 15 seconds.

### Is Duration measured in seconds?

Yes. The `Duration (sec)` field is measured in seconds and accepts integer values from 4 to 15.

### Can I drop an EXR sequence folder?

Yes. In H.264 MP4 mode, drop the folder that contains the numbered `.exr` sequence. The app uses the largest numbered EXR sequence in that folder and converts it to MP4.

Supported naming examples:

```text
shot_0001.exr
shot_0002.exr
shot_0003.exr
```

The sequence must be continuous. If a frame is missing, the app reports the missing frame number instead of silently making a broken video.

EXR folders are read at 25 fps, then looped or trimmed to the selected `Duration (sec)`.

### Why is the encoder CPU x264 High10?

The final video requirement is 10-bit H.264 MP4. The local NVIDIA H.264 encoder reports that 10-bit encode is not supported, so the app uses `libx264` High 10 for the final output.

### Can NVIDIA GPU encoding be used for the final video?

Not for the current 10-bit H.264 target. NVIDIA GPU encoding is faster for 8-bit H.264 on many machines, but this app now prioritizes the final 10-bit spec.

### What does 16 px grid mean?

When enabled, the output video width and height are rounded down to the nearest multiple of 16 pixels. This is useful for technical pipelines that require dimensions aligned to a 16 px grid.

### Is H.264 truly lossless?

The default `Visually lossless` option uses CRF 16, which is high quality but still technically lossy. The `Lossless H.264` option uses CRF 0 in High 10, but files can become much larger and may not be accepted by every downstream tool.

### Does the app keep audio?

No. H.264 MP4 mode currently exports video only and removes audio.

### How do updates work?

The app checks the latest GitHub Release on startup and when you press `Updates`. If a newer installer exists, the app shows an update window inside the app. Press `Download and install` to download the installer locally and launch it without opening GitHub in the browser.

### Why can't I add files before choosing an output folder?

The app needs a destination before building the queue, so the drop zone is visually blocked until an output folder is selected.

### How do I make a new release?

Update `package.json`, commit the changes, create a tag, and push it:

```powershell
git tag v0.1.2
git push origin main
git push origin v0.1.2
```

If the GitHub Actions workflow is enabled, GitHub builds the Windows files automatically. If the workflow has not been pushed yet, build locally with `npm.cmd run dist` and upload the files in `dist/` to a GitHub Release.

### Why is the workflow file not pushed sometimes?

GitHub requires the CLI token to have the `workflow` scope before it can push `.github/workflows/*.yml`. Refresh it once:

```powershell
gh auth refresh -h github.com -s workflow
git push
```

### What should I do if the app closes immediately?

Use the latest release and prefer the installer or `win.zip`. If it still closes, check:

```text
%LOCALAPPDATA%\GFX Ai Conv\logs
```

Also check Windows Event Viewer under `Windows Logs > Application`.
