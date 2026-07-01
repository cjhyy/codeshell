/** Timezone data derived entirely from the JS engine (Intl) — no hardcoded
 *  list to maintain. `allTimezones()` returns every IANA zone the runtime
 *  supports; offsets computed via Intl.DateTimeFormat. The stored value is
 *  always an IANA id (handles DST); the UTC-offset dropdown only filters. */

export function allTimezones(): string[] {
  const withSupported = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  if (typeof withSupported.supportedValuesOf === "function") {
    return withSupported.supportedValuesOf("timeZone");
  }
  return ["UTC", "Asia/Shanghai", "America/New_York", "Europe/London", "Asia/Tokyo"];
}

export function offsetBucket(tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date());
    const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
    const m = raw.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    const h = parseInt(m[2], 10);
    const min = m[3] ? parseInt(m[3], 10) : 0;
    return sign * (h * 60 + min);
  } catch {
    return 0;
  }
}

function fmtOffset(mins: number): string {
  const sign = mins < 0 ? "-" : "+";
  const abs = Math.abs(mins);
  const h = Math.floor(abs / 60);
  const min = abs % 60;
  return min === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(min).padStart(2, "0")}`;
}

export function offsetLabel(tz: string): string { return fmtOffset(offsetBucket(tz)); }
export function bucketLabel(bucket: number): string { return fmtOffset(bucket); }

export function uniqueOffsetBuckets(): number[] {
  const set = new Set<number>();
  for (const tz of allTimezones()) set.add(offsetBucket(tz));
  return [...set].sort((a, b) => a - b);
}

export function systemTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}
