"""Metadata only: verify actual source/Git bytes before the single guarded shard."""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).resolve().parent
BASE='ac314bf73e99399b72ec0aa7c8ce9d5c3ab4bc2f'
PATH='packages/tui/src/render/bidi.ts'
raw=(ROOT/PATH).read_bytes()
frozen=subprocess.run(['git','show',f'{BASE}:{PATH}'],cwd=ROOT,check=True,stdout=subprocess.PIPE).stdout
assert raw==frozen
text=raw.decode()
marker='function hasRTLCharacters(text: string): boolean {'
start=text.index(marker)
function=text[start:].strip()
assert function.endswith('}')
line=text.splitlines()[136]
first_escape=line.index('\\')
record={'frozenBase':BASE,'sourcePath':PATH,'sourceSha256':hashlib.sha256(raw).hexdigest(),'currentMatchesFrozen':raw==frozen,'sourceFunctionLines':[132,140],'sourceFunctionSha256':hashlib.sha256(function.encode()).hexdigest(),'regexLine':137,'regexLinePythonRepr':repr(line),'firstEscapeUtf8Bytes':list(line.encode()[first_escape:first_escape+8]),'doubleBackslashUnicodeEscapeCount':line.count('\\\\u'),'compiledTransformation':'Remove only `: string` and `: boolean` from function signature; regex and body copied verbatim.','importsExecuted':[],'platformGateExecuted':False,'dependencyResolutionAttempted':False}
(HERE/'bidi-preflight.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(record,ensure_ascii=False))
