from pathlib import Path
import subprocess,json
root=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');out=Path('/tmp/codeshell-audit-round164-model-catalog')
r=subprocess.run(['rg','--files','packages/core/src','packages/coding/src','packages/desktop/src/renderer/settings'],cwd=root,capture_output=True,text=True)
(out/'caller-filenames.all.stdout.txt').write_text(r.stdout);(out/'caller-filenames.stderr.txt').write_text(r.stderr);(out/'caller-filenames.exit.json').write_text(json.dumps({'exitCode':r.returncode})+'\n')
selected=[p for p in r.stdout.splitlines() if any(s in p for s in ['generate-image','generate-video','gen-connections','model-connections','model-catalog/','textConnections','ModelConnection','ModelCatalog','engine/runtime.','engine/engine.'])]
(out/'caller-filename-selection.json').write_text(json.dumps(selected,indent=2)+'\n')
print('\n'.join(selected))
