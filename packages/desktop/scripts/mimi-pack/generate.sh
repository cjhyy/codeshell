#!/bin/sh
# Generate one performer row strip per move with Codex's built-in image tool.
# Usage: scripts/mimi-pack/generate.sh <run-dir> [move ...]
# The run dir receives refs/, guides/, decoded/<move>.png and logs. Requires a
# signed-in `codex` CLI with the hatch-pet and imagegen skills installed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
run=$(mkdir -p "$1" && cd "$1" && pwd); shift
moves=${*:-"sit-type kick poke lie-wait"}
python3 "$here/assemble.py" refs --run "$run"
for move in $moves; do
  python3 - "$here/worker.md" "$here/prompts/$move.txt" "$run/decoded/$move.png" > "$run/job-$move.md" <<'PY'
import sys
template, prompt, out = (open(sys.argv[1]).read(), open(sys.argv[2]).read(), sys.argv[3])
print(template.replace("{PROMPT}", prompt).replace("{OUT}", out))
PY
  # One worker per strip, in parallel; each attaches the identity references.
  codex exec --skip-git-repo-check --ephemeral -s workspace-write -C "$run" --add-dir "$run" \
    -i "$run/refs/base.png" -i "$run/refs/style-sheet.png" -i "$run/guides/$move.png" \
    - < "$run/job-$move.md" > "$run/log-$move.txt" 2>&1 &
done
wait
ls "$run/decoded"
