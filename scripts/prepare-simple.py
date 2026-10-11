"""Prepare redistributable ACES data and freeze the isolated worker."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[1]
ACES_REVISION = "3af87f1d70ca3ea2a19cfd431b80de8014a00763"
ACES_URL = f"https://api.github.com/repos/colour-science/OpenColorIO-Configs/git/trees/{ACES_REVISION}?recursive=1"


def download(url):
    request = urllib.request.Request(url, headers={"User-Agent": "GFX-Ai-Conv-build"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def blob_hash(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def prepare_config():
    target = ROOT / "resources" / "aces_1.2"
    cache = ROOT / ".cache-simple"
    cache.mkdir(exist_ok=True)
    tree_path = cache / f"aces-tree-{ACES_REVISION}.json"
    if not tree_path.exists():
        tree_path.write_bytes(download(ACES_URL))
    tree = json.loads(tree_path.read_text(encoding="utf-8"))
    if tree.get("truncated"):
        raise RuntimeError("Truncated ACES source tree")
    target.mkdir(parents=True, exist_ok=True)
    entries = [entry for entry in tree["tree"] if entry["type"] == "blob" and
               (entry["path"].startswith("aces_1.2/luts/") or entry["path"] in
                {"aces_1.2/config.ocio", "aces_1.2/README.md", "aces_1.2/LICENSE.md"})]
    def fetch(entry):
        destination = (target / entry["path"][len("aces_1.2/"):]).resolve()
        if not destination.is_relative_to(target.resolve()):
            raise RuntimeError("Unsafe ACES source path")
        if destination.exists() and blob_hash(destination.read_bytes()) == entry["sha"]:
            return
        data = download(f"https://raw.githubusercontent.com/colour-science/OpenColorIO-Configs/{ACES_REVISION}/{entry['path']}")
        if blob_hash(data) != entry["sha"]:
            raise RuntimeError(f"ACES blob integrity mismatch: {entry['path']}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(fetch, entries))
    if not (target / "config.ocio").is_file() or not (target / "LICENSE.md").is_file():
        raise RuntimeError("ACES config or license missing")
    info = {"revision": ACES_REVISION, "source": ACES_URL,
            "files": {entry["path"][len("aces_1.2/"):]: entry["sha"] for entry in entries}}
    (target / "bundle.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    return target


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-only", action="store_true")
    args = parser.parse_args()
    print(f"ACES: {prepare_config()}", flush=True)
    if args.config_only:
        return
    subprocess.run([
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--console",
        "--name", "gfx-worker", "--distpath", str(ROOT / "resources" / "simple-runtime"),
        "--workpath", str(ROOT / "build" / "simple-worker"),
        "--specpath", str(ROOT / "build" / "simple-worker"),
        "--collect-all", "OpenImageIO", "--collect-all", "PyOpenColorIO",
        str(ROOT / "backend" / "simple" / "worker.py")
    ], check=True, cwd=ROOT)
    notices = ROOT / "resources/simple-runtime/licenses"
    notices.mkdir(parents=True, exist_ok=True)
    for name in ("numpy", "OpenImageIO", "opencolorio", "pyinstaller"):
        distribution = importlib.metadata.distribution(name)
        for entry in distribution.files or []:
            if any(token in str(entry).lower() for token in ("license", "copyright", "notice")):
                source = Path(distribution.locate_file(entry))
                if source.is_file():
                    destination = notices / name / str(entry).replace("../", "").replace("..\\", "")
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, destination)
    python_license = Path(sys.base_prefix) / "LICENSE.txt"
    if not python_license.exists():
        raise RuntimeError("Python runtime license missing")
    shutil.copyfile(python_license, notices / "PYTHON_LICENSE.txt")


if __name__ == "__main__":
    main()
