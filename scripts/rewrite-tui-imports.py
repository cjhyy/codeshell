#!/usr/bin/env python3
"""
Rewrite cross-package imports in packages/tui/src/ to use @cjhyy/code-shell-core.
"""

import re
import os
import sys
from pathlib import Path

# Core directories (everything that lives in packages/core/src/)
CORE_DIRS = [
    'engine', 'tool-system', 'hooks', 'llm', 'session', 'context',
    'prompt', 'protocol', 'skills', 'plugins', 'settings', 'logging',
    'preset', 'run', 'arena', 'product', 'services', 'agent', 'cron',
    'git', 'lsp', 'remote', 'utils', 'data',
]

# Core top-level files (src/X.ts that moved to core)
CORE_TOP_FILES = [
    'types', 'exceptions', 'cost-tracker', 'onboarding', 'updater',
    'migrate-models', 'state', 'registry',
]

# CLI stubs that are actually core (src/cli/X.ts)
CLI_CORE_STUBS = ['cost-tracker', 'onboarding', 'updater', 'migrate-models']

# Build patterns
core_dirs_pattern = '|'.join(re.escape(d) for d in CORE_DIRS)
core_files_pattern = '|'.join(re.escape(f) for f in CORE_TOP_FILES)
cli_stubs_pattern = '|'.join(re.escape(f) for f in CLI_CORE_STUBS)

# Regex patterns to match and replace
# Note: we handle both static imports (from "..." or from '...') and dynamic imports
# Q = quote character (either " or ')
def make_patterns(Q: str, DQ: str) -> list:
    """Make patterns for a given quote character. DQ is the replacement quote."""
    return [
        # dir-style static import: from "../../engine/engine.js" etc.
        (re.compile(r'from ' + Q + r'(\.\./)+(?:' + core_dirs_pattern + r')/[^' + Q + r']*' + Q), f'from {DQ}@cjhyy/code-shell-core{DQ}'),
        # top-level file static import: from "../../types.js" etc.
        (re.compile(r'from ' + Q + r'(\.\./)+(?:' + core_files_pattern + r')\.js' + Q), f'from {DQ}@cjhyy/code-shell-core{DQ}'),
        # cli stubs static import: from "../../cli/cost-tracker.js" etc.
        (re.compile(r'from ' + Q + r'(\.\./)+cli/(?:' + cli_stubs_pattern + r')\.js' + Q), f'from {DQ}@cjhyy/code-shell-core{DQ}'),
        # dir-style dynamic import: import("../../engine/engine.js") etc.
        (re.compile(r'import\(' + Q + r'(\.\./)+(?:' + core_dirs_pattern + r')/[^' + Q + r']*' + Q + r'\)'), f'import({DQ}@cjhyy/code-shell-core{DQ})'),
        # top-level file dynamic import: import("../../types.js") etc.
        (re.compile(r'import\(' + Q + r'(\.\./)+(?:' + core_files_pattern + r')\.js' + Q + r'\)'), f'import({DQ}@cjhyy/code-shell-core{DQ})'),
        # cli stubs dynamic import: import("../../cli/cost-tracker.js") etc.
        (re.compile(r'import\(' + Q + r'(\.\./)+cli/(?:' + cli_stubs_pattern + r')\.js' + Q + r'\)'), f'import({DQ}@cjhyy/code-shell-core{DQ})'),
    ]

PATTERNS = make_patterns('"', '"') + make_patterns("'", '"')

def rewrite_file(filepath: Path) -> int:
    """Returns number of replacements made."""
    content = filepath.read_text(encoding='utf-8')
    original = content
    count = 0
    for pattern, replacement in PATTERNS:
        new_content, n = pattern.subn(replacement, content)
        count += n
        content = new_content
    if content != original:
        filepath.write_text(content, encoding='utf-8')
    return count

def main():
    tui_src = Path('/Users/admin/Documents/个人学习/代码学习/codeshell/packages/tui/src')
    total = 0
    changed_files = []
    for f in sorted(tui_src.rglob('*.ts')) + sorted(tui_src.rglob('*.tsx')):
        n = rewrite_file(f)
        if n > 0:
            changed_files.append((f, n))
            total += n

    for f, n in changed_files:
        rel = f.relative_to(tui_src)
        print(f"  {rel}: {n} replacements")
    print(f"\nTotal: {total} replacements across {len(changed_files)} files")

if __name__ == '__main__':
    main()
