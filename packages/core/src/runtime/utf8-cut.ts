/**
 * Largest cut length ≤ `maxBytes` that does not split a multibyte UTF-8
 * character in `buf`. Used to paginate a large output burst without emitting a
 * `�` replacement char (and to keep the consumed-bytes cursor on a boundary so
 * the next read resumes cleanly).
 *
 * UTF-8: a continuation byte is 0b10xxxxxx (0x80–0xBF); a lead byte starts a
 * new character. If the byte at `maxBytes` is a continuation byte, we're mid
 * -character, so walk back to the last lead byte and cut there.
 */
export function utf8SafeCutLength(buf: Buffer, maxBytes: number): number {
  if (maxBytes >= buf.length) return buf.length;
  if (maxBytes <= 0) return 0;
  let cut = maxBytes;
  // Back off while the byte at the cut position is a UTF-8 continuation byte
  // (0x80–0xBF) — that means the char starting before `cut` isn't complete yet.
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
    cut--;
  }
  return cut;
}
