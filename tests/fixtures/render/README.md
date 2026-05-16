# Render Fixtures

Byte sequences captured from terminals, used by unit tests under `tests/`.
Tests load these files with `loadFixture(name)` (see `tests/render-fixtures.ts`).

## Format

One sequence per file. The first line of a `.txt` file is a `#` comment
describing the capture (terminal, key combo, terminal mode). Subsequent
non-comment lines are concatenated and JSON-decoded (`"..."` form) to bytes.

Example (`plain.txt`):

    # xterm: typing "a"
    "a"

To recapture: enable `CODESHELL_INPUT_TAP=1` in the dev UI; sequences go to
`~/.code-shell/logs/ui-ink/input.log`. Copy the relevant chunk in JSON string
form into a fixture file.
