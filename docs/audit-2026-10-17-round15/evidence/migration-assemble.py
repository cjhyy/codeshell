"""Metadata only. Does not import product code, execute tests, or write Git."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

BASE = Path(__file__).resolve().parents[3]
BATCH = BASE / "docs/audit-2026-10-17-round15"
EV = BATCH / "evidence"
FROZEN = "ae777b3fce6fc9986e69ceb62802f3bb3f6aa478"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(name, value):
    (EV / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


sources = {
    "CODESHELL.md": "full instruction read",
    "packages/core/src/settings/migrate-config.ts": "full source read; actual pure function with ordinary data only; no sandbox config field",
    "packages/core/src/settings/migrate-config.test.ts": "full static read; existing test file not executed",
    "packages/core/src/plugins/installer/parseSource.ts": "full source read; actual pure source metadata function",
    "packages/core/src/plugins/installer/parseSource.test.ts": "full static read; existing test file not executed",
    "packages/core/src/plugins/installer/normalizeManifest.ts": "full static read only; no disk-backed normalization or asset validation executed",
    "packages/core/src/plugins/installer/types.ts": "full static schema read; no separate schema validation run",
    "packages/core/src/plugins/gitOps.ts": "static source read, including pure githubRepoToCloneUrl; no Git/process wrapper called",
    "packages/core/src/plugins/installer/installFromSource.ts": "static consumer read only; no installer called",
    "packages/core/src/plugins/installer/preview.ts": "static selected lines 1-185 only; no preview called",
    "packages/core/src/plugins/installer/installFromNpm.ts": "rg-selected selector/resolution references only; no npm registry or installation execution",
    "packages/core/src/settings/manager.ts": "rg-selected migration references and lines 395-446 only; no SettingsManager constructed",
    "packages/core/src/settings/schema.ts": "rg-selected migration references and lines 150-225 only; no validateSettings run",
    "packages/core/src/model-catalog/builtin.ts": "static lines 1-250 and 360-439 plus three id references; imported catalog data used by migration, no model request",
    "packages/core/src/llm/capabilities/index.ts": "static selected lines 1-110 dependency review; transitively imported as pure catalog dependency",
    "packages/core/src/llm/capabilities/param-specs.ts": "static selected lines 1-90 dependency review; transitively imported as pure catalog dependency",
    "packages/core/src/runtime/safe-spawn.ts": "static selected lines 1-70 import review; not executed",
    "packages/core/src/runtime/spawn-common.ts": "static selected lines 1-90 import review; not executed",
    "packages/core/src/utils/exec.ts": "static selected lines 1-70 import review; no executable resolution called",
    "packages/tui/src/cli/commands/plugin.ts": "static lines 1-105 and 15-49 producer/consumer review; no CLI action executed",
    "scripts/run-bun-test-shard.mjs": "static lines 1-90 wrapper read; two actual guarded executions separately captured",
    "scripts/bun-test-completion.mjs": "rg-selected guard/environment references only; runner executed via prescribed wrapper",
    "docs/superpowers/specs/2026-05-29-plugin-remote-install-design.md": "selected historical grammar lines 70-103 and dedup matching lines; not proof of unsupported edge input contract",
    "docs/architecture/13-plugin-parity-and-video-editor.md": "rg-selected npm/source references and historical dedup matches only",
    "docs/audit-2026-10-17-round4/settings.md": "full prior candidate/dedup read; no old tests rerun",
    "docs/audit-2026-10-17-round8/plugins.md": "dedup selected related report lines only; no old tests rerun",
    "docs/audit-2026-10-17-round11/evidence/root-composition-controls.test.ts": "static historical fixture lines 1-90 only, no execution or reuse",
}
manifest = []
for path, scope in sources.items():
    frozen_bytes = subprocess.check_output(["git", "show", f"{FROZEN}:{path}"], cwd=BASE)
    current = (BASE / path).read_bytes()
    manifest.append({"path": path, "sha256": sha(frozen_bytes), "bytes": len(frozen_bytes), "scope": scope,
                     "currentSha256": sha(current), "currentEqualsFrozen": current == frozen_bytes})
save("migration-source-manifest.json", {"base": FROZEN, "files": manifest,
     "limits": "Selected dependencies/callers are not full-module coverage. Installed semver metadata lookup failed and was skipped; its exact installed version/path is unpinned."})

runs = []
for lane in ["config", "source"]:
    stem = f"migration-{lane}-pure"
    receipt = json.loads((EV / f"{stem}.first.exit.json").read_text())
    raw = (EV / f"{stem}.first.log").read_bytes()
    assert sha(raw) == receipt["rawSha256"]
    text = raw.decode()
    match = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.", text)
    assert match and receipt["exitCode"] == 0
    tests, skips, fails = map(int, match.groups())
    assert skips == 0 and fails == 0
    expects = int(re.search(r"(\d+) expect\(\) calls", text).group(1))
    runs.append({**receipt, "receipt": f"evidence/{stem}.first.exit.json", "completed": True,
                 "passed": tests, "tests": tests, "failed": fails, "skipped": skips, "expects": expects})
save("migration-validation.json", {"base": FROZEN, "firstExecutions": runs, "cleanShards": 2,
     "failedBunShards": 0, "successfulTests": sum(r["passed"] for r in runs),
     "expectations": sum(r["expects"] for r in runs), "failedTests": 0, "skippedTests": 0,
     "existingTestsExecuted": 0, "newFocusedTestsExecuted": 11,
     "metadataFailures": {"count": 3, "note": "evidence/migration-navigation-skip.md", "productImportOrBun": False,
                          "repairedOrRetried": False},
     "networkOrNativeExecuted": False, "productEdits": False, "gitWrites": False})
save("migration-findings.json", {"base": FROZEN, "findings": []})
save("migration-candidates.json", {"base": FROZEN, "candidates": [{
    "id": "MIG-R15-C1", "title": "Source .git normalization edge observations", "severity": None,
    "status": "observed-pure-candidate-contract-incomplete",
    "sources": [{"path": "packages/core/src/plugins/installer/parseSource.ts", "lines": [123, 124, 125, 182, 187]},
                {"path": "packages/core/src/plugins/gitOps.ts", "lines": [206, 207]}],
    "observations": ["HTTPS .git/ source preserves inferredName notes.git; no trailing slash control gives notes",
                     "github:owned/notes.git appends .git again; suffix-free shorthand control gives one .git"],
    "actualFunction": "parseSource", "fixture": "evidence/migration-source-pure.test.ts",
    "rawLog": "evidence/migration-source-pure.first.log", "exit": "evidence/migration-source-pure.first.exit.json",
    "producerStaticOnly": "CLI plugin install forwards user source and consumes inferredName when --name absent",
    "missingEvidence": "Current supported-input contract/normal application producer for these two boundary forms; no remote or clone validation",
    "limits": ["No Git command", "No clone", "No install", "No CLI execution", "No remote existence claim", "No security or credential experiment"]
}], "related": [{"id": "C-SET-02", "origin": "docs/audit-2026-10-17-round4/settings.md",
     "status": "old static candidate excluded, not dynamically revalidated", "topic": "generic gap/future version stamp"}]})

paths = [BATCH / "migration.md"] + sorted(p for p in EV.glob("migration-*") if p.is_file() and p.name != "migration-artifact-receipt.json")
artifacts = [{"path": p.relative_to(BATCH).as_posix(), "bytes": p.stat().st_size, "sha256": sha(p.read_bytes())} for p in paths]
save("migration-artifact-receipt.json", {"base": FROZEN, "worker": "config_migration_round15", "report": "migration.md",
     "formalCount": 0, "candidateCount": 1, "relatedCount": 1, "testsExecuted": 11, "expectations": 27,
     "cleanBunShards": 2, "failedBunShards": 0, "metadataFailures": 3,
     "rawLogs": ["evidence/migration-config-pure.first.log", "evidence/migration-source-pure.first.log"],
     "artifacts": artifacts})
print(json.dumps({"sources": len(manifest), "artifacts": len(artifacts), "cleanShards": 2, "tests": 11, "expects": 27}))
