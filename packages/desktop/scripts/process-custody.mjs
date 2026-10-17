const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function invalidMetadata() {
  return new Error("Invalid process custody birth metadata");
}

function birthOrder(birth) {
  if (typeof birth !== "string" || birth.length > 80) throw invalidMetadata();
  const windows = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})Z$/.exec(birth);
  const posix =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
      birth,
    );
  if (!windows && !posix) throw invalidMetadata();
  const [year, month, day, hour, minute, second] = windows
    ? windows.slice(1, 7).map(Number)
    : [Number(posix[7]), months.indexOf(posix[2]) + 1, ...posix.slice(3, 7).map(Number)];
  // Validate the calendar without Date.parse normalization. Windows ordering
  // uses the complete original seven-digit fraction, never millisecond epochs.
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second ||
    (posix && weekdays[calendar.getUTCDay()] !== posix[1])
  )
    throw invalidMetadata();
  return {
    kind: windows ? "windows" : "posix",
    value: windows
      ? birth
      : [year, month, day, hour, minute, second]
          .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
          .join(""),
  };
}

/** Expand only from an observed process incarnation that is still alive. */
export function rememberOwnedProcesses(owned, current) {
  // Validate the complete snapshot before mutating custody. Failed metadata
  // reaches the existing watchdog failed-query latch, never partial authority.
  const order = new Map();
  let kind;
  const validate = (item) => {
    const birth = birthOrder(item.birth);
    if (kind && birth.kind !== kind) throw invalidMetadata();
    kind = birth.kind;
    return birth;
  };
  for (const item of owned.values()) validate(item);
  for (const item of current) {
    if (order.has(item.pid)) throw invalidMetadata();
    order.set(item.pid, validate(item));
  }
  const ids = new Set(
    current.filter((item) => owned.get(item.pid)?.birth === item.birth).map((item) => item.pid),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of current) {
      if (!ids.has(item.ppid) || ids.has(item.pid)) continue;
      const previous = owned.get(item.pid);
      // A PID can be reused after the original process died. Never re-authorize
      // that new incarnation or discover its children through the stale PID.
      if (previous && previous.birth !== item.birth) continue;
      // PPID can refer to a reused PID. A process born before the freshly
      // observed pinned parent is not its child. Equality preserves native
      // POSIX second precision; Windows retains all seven fractional digits.
      if (order.get(item.pid).value < order.get(item.ppid).value) continue;
      owned.set(item.pid, item);
      ids.add(item.pid);
      changed = true;
    }
  }
}
