#!/usr/bin/env python3
"""
Rewrite test file imports that reference moved TUI files.
src/ui/ → packages/tui/src/ui/
src/render/ → packages/tui/src/render/
src/cli/commands/ → packages/tui/src/cli/commands/
src/cli/input-compiler → packages/tui/src/cli/input-compiler
(but NOT src/cli/cost-tracker, src/cli/onboarding etc - they're core stubs)
"""

import re
from pathlib import Path

TESTS_DIR = Path('/Users/admin/Documents/个人学习/代码学习/codeshell/tests')

# Directories that moved to TUI
TUI_DIRS = ['ui', 'render', 'native-ts', 'voice', 'bootstrap']

# CLI files that moved to TUI (not the stubs: cost-tracker, onboarding, updater, migrate-models stay as stubs)
# These CLI files moved: main.ts, exit.ts, input-compiler.ts, commands/, input/, output/
TUI_CLI_PATHS = [
    'cli/commands/',
    'cli/input/',
    'cli/output/',
    'cli/main',
    'cli/exit',
    'cli/input-compiler',
]

def should_rewrite_to_tui(import_path: str) -> bool:
    """Determine if this import should be rewritten to packages/tui."""
    # src/ui/, src/render/, etc.
    for d in TUI_DIRS:
        if f'src/{d}/' in import_path:
            return True
    # src/cli/commands/, src/cli/input/, etc.
    for cli_path in TUI_CLI_PATHS:
        if f'src/{cli_path}' in import_path:
            return True
    return False

def rewrite_import(import_path: str, depth: int) -> str:
    """Rewrite a src/ import to packages/tui/src/ equivalent."""
    # import_path is like ../src/ui/store.js or ../../src/render/index.js
    # Replace src/ with packages/tui/src/
    if not should_rewrite_to_tui(import_path):
        return import_path
    return import_path.replace('/src/', '/packages/tui/src/')

def rewrite_file(filepath: Path) -> int:
    content = filepath.read_text(encoding='utf-8')
    original = content

    # Match from "..." and from '...' style imports
    def replacer(m: re.Match) -> str:
        quote = m.group(1)
        path = m.group(2)
        if '/src/ui/' in path or '/src/render/' in path or '/src/native-ts/' in path:
            new_path = path.replace('/src/', '/packages/tui/src/')
            return f'from {quote}{new_path}{quote}'
        # CLI paths that moved to TUI
        for cli_path in TUI_CLI_PATHS:
            if f'/src/{cli_path}' in path:
                new_path = path.replace('/src/', '/packages/tui/src/')
                return f'from {quote}{new_path}{quote}'
        return m.group(0)

    content = re.sub(r'from (["\'])((?:\.\./)(?:\.\./)*.+?)\1', replacer, content)

    if content != original:
        filepath.write_text(content, encoding='utf-8')
        return content.count('@cjhyy') - original.count('@cjhyy') + 1  # rough count
    return 0

def main():
    total = 0
    changed = []
    for f in sorted(TESTS_DIR.rglob('*.ts')) + sorted(TESTS_DIR.rglob('*.tsx')):
        old = f.read_text(encoding='utf-8')
        n = rewrite_file(f)
        new = f.read_text(encoding='utf-8')
        if old != new:
            changed.append(f.name)
            total += 1

    for name in changed:
        print(f"  Updated: {name}")
    print(f"\nTotal files updated: {total}")

if __name__ == '__main__':
    main()
