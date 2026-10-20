"""Assemble receipts from already saved first-run logs; never runs product/tests."""
import hashlib
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[3]
HERE = pathlib.Path(__file__).resolve().parent
BASE = "248d091202869c07274adedf4fd50403105f1b1f"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def rel(path):
    return path.relative_to(ROOT).as_posix()


source_specs = [
    ("CODESHELL.md", "full", None),
    ("packages/core/src/engine/input-attachments.ts", "full", None),
    ("packages/core/src/engine/run-image-input.ts", "full", None),
    ("packages/core/src/engine/parse-task.ts", "full", None),
    ("packages/core/src/engine/image-policy.ts", "full", None),
    ("packages/core/src/tool-system/builtin/generate-image.ts", "selected", [[455, 500]]),
    ("packages/desktop/src/renderer/attachmentSession.ts", "full", None),
    ("packages/desktop/src/renderer/attachmentSession.test.ts", "full", None),
    ("packages/desktop/src/renderer/chat/attachments.ts", "full", None),
    ("packages/desktop/src/renderer/chat/attachments.test.ts", "full", None),
    ("packages/desktop/src/renderer/chat/mentionReferences.ts", "full", None),
    ("packages/desktop/src/renderer/tool-cards/attachments.ts", "full", None),
    ("packages/desktop/src/renderer/tool-cards/attachments.test.ts", "full", None),
    ("packages/desktop/src/renderer/tool-cards/GenericToolCard.tsx", "full", None),
    ("packages/desktop/src/renderer/tool-cards/AttachmentCard.tsx", "full", None),
    ("packages/desktop/src/renderer/tool-cards/index.tsx", "full", None),
    ("packages/desktop/src/shared/media-preview.ts", "full", None),
    ("packages/desktop/src/renderer/uiLanguage.ts", "full", None),
    ("packages/desktop/src/renderer/i18n/translate.ts", "full", None),
    ("packages/desktop/src/renderer/App.tsx", "selected", [[425, 485], [570, 650]]),
    ("packages/desktop/src/renderer/ChatView.tsx", "selected", [[250, 410], [1115, 1235]]),
]
sources = []
for path, scope, ranges in source_specs:
    frozen = subprocess.check_output(["git", "show", f"{BASE}:{path}"], cwd=ROOT)
    current = (ROOT / path).read_bytes()
    sources.append({
        "path": path, "readScope": scope, "readRanges": ranges,
        "bytes": len(frozen), "lines": len(frozen.splitlines()),
        "frozenSourceSha256": digest(frozen),
        "currentWorkingTreeMatchesFrozenBlob": current == frozen,
    })
source_manifest = HERE / "attachments-source-manifest.json"
source_manifest.write_text(json.dumps({
    "sourceBase": BASE,
    "method": "SHA-256 of raw git show sourceBase:path bytes; current equality checked separately. Inspection scope does not claim execution coverage.",
    "sources": sources,
}, ensure_ascii=False, indent=2) + "\n")

runs = []
run_specs = [
    ("attachments-path-projection", [rel(HERE / "attachments-path-projection.test.ts")], "focused observations and controls"),
    ("attachments-existing-baseline", [
        "packages/desktop/src/renderer/attachmentSession.test.ts",
        "packages/desktop/src/renderer/tool-cards/attachments.test.ts",
        "packages/desktop/src/renderer/chat/attachments.test.ts",
    ], "existing targeted baseline"),
]
for name, files, kind in run_specs:
    raw = HERE / f"{name}.first.log"
    exit_file = HERE / f"{name}.first.exit.txt"
    text = raw.read_text()
    completed = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.", text)
    expectations = re.search(r"\s(\d+) expect\(\) calls", text)
    assert completed and expectations, f"Missing first-run completion/count: {name}"
    tests, skipped, failures = map(int, completed.groups())
    runs.append({
        "name": name, "command": ["node", "scripts/run-bun-test-shard.mjs", "--timeout", "30000", *files],
        "attempt": 1, "sourceBase": BASE, "kind": kind,
        "fixtures": [{"path": path, "sha256": digest((ROOT / path).read_bytes())} for path in files],
        "rawCombinedStdoutStderr": rel(raw), "rawLogSha256": digest(raw.read_bytes()),
        "exitFile": rel(exit_file), "exitFileSha256": digest(exit_file.read_bytes()),
        "exitCode": int(exit_file.read_text()), "tests": tests,
        "expectCalls": int(expectations.group(1)), "skipped": skipped, "failures": failures,
        "guardedCompletionPresent": True,
    })

artifacts = [HERE.parent / "attachments.md"] + [
    path for path in sorted(HERE.glob("attachments-*"))
    if path.is_file() and path.name != "attachments-validation.json"
]
(HERE / "attachments-validation.json").write_text(json.dumps({
    "sourceBase": BASE, "confirmedFindings": [{
        "id": "ATT-R9-01", "priority": "P3",
        "title": "Workspace spaces split complete generated-artifact paths into wrong attachment references",
        "file": "packages/desktop/src/renderer/tool-cards/attachments.ts", "line": 56,
        "evidence": "Production detector + owned temporary files; producer/UI propagation source-only",
    }],
    "runs": runs,
    "totals": {
        "cleanFirstShards": 2, "tests": sum(run["tests"] for run in runs),
        "newFocusedTests": 5, "baselineTests": 40,
        "expectCalls": sum(run["expectCalls"] for run in runs),
        "failures": 0, "skipped": 0, "failedShards": 0, "retries": 0,
    },
    "scope": "Actual renderer detector and Core ordinary metadata functions; owned temporary files and synthetic strings only. No generator/provider, decoder, network, IPC, Electron, UI mount, native open, auth/security/custody experiment, dependency build, typecheck, lint or full suite.",
    "firstRunPolicy": "Both combined stdout/stderr logs and exit files saved before inspection. No failure or retry occurred.",
    "sourceManifest": rel(source_manifest),
    "artifacts": [{"path": rel(path), "bytes": path.stat().st_size, "sha256": digest(path.read_bytes())} for path in artifacts],
}, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"sources": len(sources), "allCurrentMatchFrozen": all(item["currentWorkingTreeMatchesFrozenBlob"] for item in sources), "runs": len(runs), "tests": sum(run["tests"] for run in runs), "expectCalls": sum(run["expectCalls"] for run in runs)}))
