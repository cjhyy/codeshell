"""Assemble audit metadata only. Does not execute tests or mutate Git/product files."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = Path(__file__).resolve().parent
BASE = "1b04838474bcd57212f80f791d0e268a00d347e3"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write(name, value):
    (EVIDENCE / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


reviewed = {
    "CODESHELL.md": "complete primary repository instructions",
    "packages/core/src/llm/providers/openai.ts": "ordinary request assembly, message normalization, stream and response conversion; auth/security/watchdog behavior excluded",
    "packages/core/src/llm/providers/anthropic.ts": "ordinary request assembly, message normalization, stream and response conversion; auth/security/cancellation behavior excluded",
    "packages/core/src/engine/model-facade.ts": "stream forwarding, response extraction and in-memory Transcript recording",
    "packages/core/src/engine/turn-loop.ts": "selected tool event tracking, final tool materialization, execution/result consumer, continuation branches; not full file",
    "packages/core/src/session/transcript.ts": "selected message/ToolResult conversion and in-memory API; not full file",
    "packages/core/src/llm/client-base.ts": "constructor, usage wrapper and ordinary provider options; no auth/custody experiments",
    "packages/core/src/llm/types.ts": "complete CreateMessageOptions and usage tracker contracts",
    "packages/core/src/types.ts": "selected Message, ContentBlock, LLMStreamChunk, StreamEvent, LLMResponse type contracts",
    "packages/web/src/lib/streamReducer.ts": "selected initial state, tool start/args/result branches; actual pure reducer used by fixture",
    "packages/desktop/src/renderer/types.ts": "selected tool start, live args and result branches; static only",
    "packages/core/package.json": "installed SDK dependency declaration only",
}
baseline_files = [
    "packages/core/src/llm/providers/" + name
    for name in [
        "anthropic-usage.test.ts",
        "anthropic-thinking.test.ts",
        "anthropic-tool-result-error.test.ts",
        "openai-tool-result-image.test.ts",
        "openai-tool-result-error.test.ts",
        "openai-max-tokens-clamp.test.ts",
    ]
]
for name in baseline_files:
    reviewed[name] = "complete existing test source read before first guarded baseline run; in-memory SDK adapters"
manifest = []
for name, mode in reviewed.items():
    frozen = git("show", f"{BASE}:{name}")
    current = (ROOT / name).read_bytes()
    manifest.append({
        "path": name,
        "bytes": len(frozen),
        "lines": len(frozen.splitlines()),
        "sha256": sha(current),
        "frozenSha256": sha(frozen),
        "matchesFrozen": current == frozen,
        "reviewMode": mode,
    })
write("providers-source-manifest.json", {
    "frozenCommit": BASE,
    "fileCount": len(manifest),
    "allMatchFrozen": all(row["matchesFrozen"] for row in manifest),
    "files": manifest,
})

sdk = (ROOT / "packages/core/node_modules/@anthropic-ai/sdk").resolve()
sdk_package = json.loads((sdk / "package.json").read_text())
dependency_files = []
for name, role in [
    ("package.json", "installed version metadata"),
    ("lib/MessageStream.mjs", "runtime imported by the successful stream fixture"),
    ("streaming.mjs", "runtime in-memory newline decoder used by MessageStream"),
    ("src/lib/MessageStream.ts", "primary installed SDK event semantics source, selected lines 409-469 and fromReadableStream path"),
    ("src/streaming.ts", "primary installed SDK newline stream source, selected fromReadableStream path"),
]:
    path = sdk / name
    data = path.read_bytes()
    dependency_files.append({
        "relativePath": "packages/core/node_modules/@anthropic-ai/sdk/" + name,
        "resolvedAbsolutePath": str(path),
        "bytes": len(data),
        "lines": len(data.splitlines()),
        "sha256": sha(data),
        "role": role,
    })
write("providers-dependency-receipt.json", {
    "package": sdk_package["name"],
    "installedVersion": sdk_package["version"],
    "declaredRange": json.loads((ROOT / "packages/core/package.json").read_text())["dependencies"]["@anthropic-ai/sdk"],
    "scope": "already installed dependency, not a frozen Git source blob; no dependency installation or build",
    "fixtureImport": "../../../packages/core/node_modules/@anthropic-ai/sdk/lib/MessageStream.mjs",
    "files": dependency_files,
})

runs = [
    ("providers-stream-contract", ["docs/audit-2026-10-17-round7/evidence/providers-stream-contract.test.ts"], True),
    ("providers-normalization-baseline", baseline_files, True),
    ("providers-thinking-roundtrip", ["docs/audit-2026-10-17-round7/evidence/providers-thinking-roundtrip.test.ts"], False),
]
receipts = []
for stem, files, clean in runs:
    log = (EVIDENCE / f"{stem}.first.log").read_text()
    exit_code = int((EVIDENCE / f"{stem}.first.exit.txt").read_text())
    def count(pattern):
        match = re.search(pattern, log)
        return int(match.group(1)) if match else None
    counts = {
        "pass": count(r"(?m)^\s*(\d+) pass$"),
        "fail": count(r"(?m)^\s*(\d+) fail$"),
        "expectCalls": count(r"(?m)^\s*(\d+) expect\(\) calls$"),
        "reportedTests": count(r"Ran (\d+) tests across"),
        "files": count(r"Ran \d+ tests across (\d+) file"),
        "completedGuardedShard": "Completed Bun shard:" in log,
    }
    receipts.append({
        "stem": stem,
        "attempt": 1,
        "command": ["node", "scripts/run-bun-test-shard.mjs", "--timeout", "30000", *files],
        "exitCode": exit_code,
        "rawCombinedStdoutStderr": f"{stem}.first.log",
        "exitReceipt": f"{stem}.first.exit.txt",
        "clean": clean,
        "observedBunCounts": counts,
        "result": "complete zero-failure guarded shard" if clean else "SKIP after first fixture failure; no repair/retry/alternate execution",
    })
write("providers-validation.json", {
    "frozenCommit": BASE,
    "runs": receipts,
    "cleanShardCount": 2,
    "cleanTotals": {"pass": 30, "fail": 0, "expectCalls": 65, "skipped": 0, "newFocusedTests": 4, "existingBaselineTests": 26},
    "failedShardCount": 1,
    "failedShardObservedTotals": {"pass": 1, "fail": 1, "expectCalls": 13},
    "failedDirection": "thinking round-trip fixture line 71 expects exact tool_result content without automatic cache_control; whole direction skipped",
    "confirmedFindings": 1,
    "candidatesNotConfirmed": 2,
    "limits": [
        "No real SDK network client, provider endpoint, fetch/socket, actual model, paid API, real user data, native app, external message or auth/security/custody/watchdog experiment.",
        "Core clients use in-memory _client adapters. Installed SDK MessageStream parses only an owned ReadableStream.",
        "No product fix, dependency build/install, clean build, typecheck, lint, or full provider/Core suite claim.",
        "Thinking failed fixture raw/exit preserved untouched. No repair/retry/alternate validation.",
        "OpenAI later-identity behavior is dynamically observed only for synthetic chunks; supported normal producer reachability remains unproven.",
    ],
})
write("providers-findings.json", [{
    "id": "PROV-R7-01",
    "priority": "P3",
    "title": "Anthropic 成功流将后一工具参数挂到前一工具，首工具参数不实时送出",
    "file": "packages/core/src/llm/providers/anthropic.ts",
    "line": 347,
    "secondaryLines": [303, 358, 363],
    "trigger": "Two sequential SDK-format tool_use blocks with start/input_json_delta/stop in one complete successful message; fixture borrows Read/Write labels and synthetic path/content fields with tools=[], not actual builtin schema validation. First-tool args disappear and second-tool args use previous id; declared real tool propagation uses the same source logic but is not executed here.",
    "impact": "Real ModelFacade/Web reducer show first tool card with second tool input and second card with empty args. Final response and Transcript inputs remain correct.",
    "evidenceLevel": "focused-dynamic-memory-installed-sdk-parser-provider-facade-web-reducer; TurnLoop fallback/repair limits source-only",
    "evidence": "providers-stream-contract.test.ts",
    "rawLog": "providers-stream-contract.first.log",
    "limitations": "No real API, Engine, executed tools, native UI, or permanent history damage. No duplicate/wrong tool execution claimed.",
    "dedup": "No matching root cause found in structured/text historical corpus scan and matched-source review; prior retry/auth/EOF findings excluded.",
}])
write("providers-candidates.json", [{
    "id": "PROV-R7-C1",
    "status": "not-confirmed-normal-producer-reachability",
    "title": "OpenAI 工具身份晚到时不会在流阶段补 start",
    "file": "packages/core/src/llm/providers/openai.ts",
    "line": 831,
    "evidence": "Synthetic in-memory iterable → actual ModelFacade/Web reducer behavior observed in passing fixture; final tool call correct.",
    "limit": "No valid normal Chat Completions or compatible-endpoint producer established. Final TurnLoop start backfill exists. Not counted as a bug.",
}, {
    "id": "PROV-R7-C2",
    "status": "skipped-after-first-fixture-failure",
    "title": "Anthropic thinking 工具续轮遗漏 thinking/redacted_thinking blocks",
    "file": "packages/core/src/llm/providers/anthropic.ts",
    "line": 385,
    "evidence": "Static normalization chain and current official thinking tool workflow contract; independent first fixture failed late at exact result shape due to unaccounted cache_control.",
    "limit": "1 pass / 1 fail / 13 expectations retained separately. No repair/retry/alternate execution or real API rejection. Not counted as a confirmed bug.",
}])
write("providers-primary-sources.json", {
    "retrievedDate": "2026-10-17",
    "sources": [{
        "url": "https://platform.claude.com/docs/en/build-with-claude/extended-thinking",
        "title": "Extended thinking — Claude Platform Docs",
        "method": "web open, first attempt successful",
        "relevantLines": [146, 150],
        "paraphrase": "Manual thinking adds a requirement for the last assistant turn to start with a thinking block; tool-loop turn structure is described on the thinking workflow page.",
        "usedFor": "Unconfirmed thinking round-trip candidate only; no executed vendor rejection claim.",
    }, {
        "url": "https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows",
        "title": "Thinking in tool and multi-turn workflows — Claude Platform Docs",
        "method": "web click from official extended-thinking page, first attempt successful",
        "relevantLines": [79, 86, 122, 150],
        "paraphrase": "Tool-result continuations must echo the complete assistant thinking content unchanged; filtering redacted thinking is described as a request error. The same round-trip rules apply to supported manual thinking.",
        "usedFor": "Unconfirmed thinking round-trip candidate only; no real API request or opaque field validation.",
    }, {
        "url": "https://developers.openai.com/api/docs/guides/function-calling#streaming",
        "title": "Function calling — Streaming — official OpenAI documentation",
        "method": "OpenAI Docs skill: official documentation connector search then fetch of matching page/anchor, both successful",
        "result": "Search hit included Chat Completions wording; fetched default section showed Responses streaming. Search hit alone was not used as an established contract.",
        "usedFor": "No affirmative normal Chat later-identity sequence established; candidate remains unconfirmed. No source failure fallback or live model request.",
    }],
})

corpus = []
matches = []
parse_errors = []
leaves = 0
patterns = {
    "anthropic-progress": re.compile(r"inputJson|currentToolId|contentBlock\b|Anthropic.{0,100}(?:错配|misrout|mismatch|参数.*前|args.*previous)", re.I),
    "openai-later-identity": re.compile(r"(?:OpenAI|tool.?call).{0,120}(?:fragment|身份|identity|later.name|晚到)|tool_use_start.{0,100}(?:missing|丢|缺)", re.I),
    "thinking-roundtrip": re.compile(r"thinking.{0,100}(?:signature|签名|tool_use|tool.call|丢|lost|preserv)|(?:signature|签名).{0,100}thinking|Anthropic.{0,100}(?:history|历史|思考|reasoning)", re.I),
}
for name in git("ls-tree", "-r", "--name-only", "-z", BASE).decode().split("\0"):
    path = Path(name)
    if path.suffix not in {".md", ".json"} or not any(word in name.lower() for word in ["audit", "review", "archive", "bug"]):
        continue
    data = git("show", f"{BASE}:{name}")
    corpus.append({"path": name, "bytes": len(data), "sha256": sha(data), "kind": path.suffix})
    text = data.decode()
    def record(value, location):
        global leaves
        leaves += 1
        for category, pattern in patterns.items():
            match = pattern.search(value)
            if match:
                matches.append({"category": category, "path": name, "location": location, "context": value[max(0, match.start() - 100):match.end() + 350]})
    if path.suffix == ".md":
        for index, line in enumerate(text.splitlines(), 1):
            record(line, f"line:{index}")
    else:
        try:
            value = json.loads(text)
        except Exception as error:
            parse_errors.append({"path": name, "error": str(error)})
            continue
        def walk(value, location=""):
            if isinstance(value, str):
                record(value, location)
            elif isinstance(value, dict):
                for key, part in value.items():
                    walk(part, location + "/" + str(key))
            elif isinstance(value, list):
                for index, part in enumerate(value):
                    walk(part, location + "/" + str(index))
        walk(value)
write("providers-dedup-corpus.json", {
    "frozenCommit": BASE,
    "fileCount": len(corpus),
    "markdownFiles": sum(row["kind"] == ".md" for row in corpus),
    "jsonFiles": sum(row["kind"] == ".json" for row in corpus),
    "searchedStringLeavesOrMarkdownLines": leaves,
    "parseErrors": parse_errors,
    "patterns": {key: value.pattern for key, value in patterns.items()},
    "matches": matches,
    "files": corpus,
    "interpretation": "Bounded regex/structured leaf scan and matched reports manually reviewed; no same Anthropic args mapping root cause identified. Not an exhaustive semantic dedup proof.",
})

artifacts = []
for path in sorted([EVIDENCE.parent / "providers.md", *EVIDENCE.glob("providers-*")]):
    if not path.is_file() or path.name == "providers-artifact-receipt.json":
        continue
    data = path.read_bytes()
    artifacts.append({"path": str(path.relative_to(ROOT)), "bytes": len(data), "sha256": sha(data)})
write("providers-artifact-receipt.json", {
    "frozenCommit": BASE,
    "artifactCount": len(artifacts),
    "confirmedFindings": 1,
    "candidateCount": 2,
    "artifacts": artifacts,
    "note": "Receipt excludes itself. Final root evidence-index is authoritative if reports are later amended. This assembler never runs tests.",
})
print(json.dumps({
    "confirmed": 1,
    "candidates": 2,
    "cleanPass": 30,
    "cleanExpect": 65,
    "failedShards": 1,
    "sourceFiles": len(manifest),
    "sdkVersion": sdk_package["version"],
    "sdkFiles": len(dependency_files),
    "corpusFiles": len(corpus),
    "parseErrors": len(parse_errors),
    "artifactCount": len(artifacts),
}))
