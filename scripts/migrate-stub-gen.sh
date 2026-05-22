#!/usr/bin/env bash
# Generate stub re-exports for a moved directory or file.
# Usage:
#   ./scripts/migrate-stub-gen.sh <dirname>      e.g. logging
#   ./scripts/migrate-stub-gen.sh <file.ts>      e.g. types.ts
# Creates src/<X>.ts (or src/<X>/<each>.ts) as re-exports pointing into
# packages/core/src/<X>. Stubs are removed in the final batch of the
# migration.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <dirname|file.ts>" >&2
  exit 1
fi

NAME="$1"

if [[ -f "packages/core/src/$NAME" ]]; then
  # Single file at top level (e.g. types.ts, exceptions.ts)
  rel="../packages/core/src/${NAME%.ts*}.js"
  mkdir -p "$(dirname "src/$NAME")"
  cat > "src/$NAME" <<EOF
// Temporary stub during monorepo migration (spec §4.3.1). Removed in batch 8.
export * from "$rel";
EOF
  echo "wrote stub: src/$NAME -> $rel"
  exit 0
fi

if [[ ! -d "packages/core/src/$NAME" ]]; then
  echo "ERROR: packages/core/src/$NAME is neither a file nor a directory" >&2
  exit 1
fi

# Directory — generate per-file stubs for every .ts/.tsx file
mkdir -p "src/$NAME"
find "packages/core/src/$NAME" -type f \( -name "*.ts" -o -name "*.tsx" \) | while read -r src; do
  rel_to_dir="${src#packages/core/src/$NAME/}"
  target_path="src/$NAME/$rel_to_dir"
  target_dir="$(dirname "$target_path")"
  mkdir -p "$target_dir"
  depth=$(echo "$rel_to_dir" | tr -cd '/' | wc -c | tr -d ' ')
  prefix=""
  for ((i=0; i<depth+2; i++)); do prefix="../$prefix"; done
  rel="${prefix}packages/core/src/$NAME/${rel_to_dir%.ts*}.js"
  cat > "$target_path" <<EOF
// Temporary stub during monorepo migration (spec §4.3.1). Removed in batch 8.
export * from "$rel";
EOF
done
echo "wrote stubs for: src/$NAME/"
