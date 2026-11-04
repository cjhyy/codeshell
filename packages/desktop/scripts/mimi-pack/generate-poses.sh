#!/bin/sh
# Generate one key-pose illustration per prompt with Codex's built-in image tool.
# Usage: scripts/mimi-pack/generate-poses.sh <run-dir> <identity-ref.png> [pose ...]
# Prompts: prompts/<character>-poses/<pose>.txt (PACK_CHARACTER, default shiro).
# Then: PACK_CHARACTER=shiro python3 scripts/mimi-pack/poses.py cut --run <run-dir>
set -eu
here=$(cd "$(dirname "$0")" && pwd)
run=$(mkdir -p "$1/decoded" && cd "$1" && pwd)
ref=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
shift 2
character=${PACK_CHARACTER:-shiro}
prompts="$here/prompts/$character-poses"
poses=${*:-$(cd "$prompts" && ls ./*.txt | sed 's#^\./##; s#\.txt$##')}
for pose in $poses; do
  python3 - "$here/worker.md" "$prompts/$pose.txt" "$run/decoded/$pose.png" > "$run/job-$pose.md" <<'PY'
import sys
template, prompt, out = (open(sys.argv[1]).read(), open(sys.argv[2]).read(), sys.argv[3])
print(template.replace("{PROMPT}", prompt).replace("{OUT}", out))
PY
  # One worker per pose, in parallel; each attaches the identity reference.
  codex exec --skip-git-repo-check --ephemeral -s workspace-write -C "$run" --add-dir "$run" \
    -i "$ref" - < "$run/job-$pose.md" > "$run/log-$pose.txt" 2>&1 &
done
wait
ls "$run/decoded"
