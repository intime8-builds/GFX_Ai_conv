"""Optional target-runtime check; writes only under output/nuke-check."""
import json
from pathlib import Path
import nuke

root = Path(__file__).resolve().parents[1]
output = root / "output/nuke-check"
output.mkdir(parents=True, exist_ok=True)
read = nuke.nodes.Read()
color = nuke.nodes.OCIOColorSpace()
result = {"version": nuke.NUKE_VERSION_STRING,
          "readKnobs": list(read.knobs()), "ocioKnobs": list(color.knobs())}
(output / "knobs.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
print("GFX_NUKE_CHECK " + nuke.NUKE_VERSION_STRING)
nuke.scriptClear()
cases_file = root / "output/smoke/nuke-cases.json"
if cases_file.exists():
    results = []
    for case in json.loads(cases_file.read_text(encoding="utf-8")):
        nuke.scriptClear()
        nuke.scriptOpen(case["script"])
        nuke.frame(case["frame"])
        node = nuke.toNode("AI_To_ACEScg")
        read_node = nuke.toNode("AI_Media")
        values = [node.sample(channel, case["x"] + 0.5, case["y"] + 0.5) for channel in ("red", "green", "blue", "alpha")]
        raw = [read_node.sample(channel, case["x"] + 0.5, case["y"] + 0.5) for channel in ("red", "green", "blue", "alpha")]
        extra = {}
        for key in ("mov64_ycbcr_matrix", "mov64_decode_video_levels", "premultiplied", "auto_alpha"):
            if key in read_node.knobs():
                knob = read_node[key]
                extra[key] = {"value": knob.value(), "choices": knob.values() if hasattr(knob, "values") else []}
        difference = max(abs(a-b) for a,b in zip(values, case["expected"]))
        results.append({**case, "actual": values, "raw": raw, "knobs": extra, "difference": difference, "pass": difference < case["tolerance"],
            "fps": nuke.root()["fps"].value(), "workingSpace": nuke.root()["workingSpaceLUT"].value(),
            "readPath": nuke.toNode("AI_Media")["file"].evaluate(), "readKnobs": list(nuke.toNode("AI_Media").knobs())})
    (output / "results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print("GFX_NUKE_RESULTS " + json.dumps([{key: item[key] for key in ("kind", "difference", "pass")} for item in results]))
    if not all(item["pass"] for item in results):
        raise RuntimeError("Nuke color comparison failed")
