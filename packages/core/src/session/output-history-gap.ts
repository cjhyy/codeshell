export interface OutputHistoryRecoveryRecord {
  version: 1;
  recoveryId: string;
  planId: string;
  historicalGap: true;
  acceptedAt: string;
  sourceJournalSha256: string;
  transcriptSha256: string;
  receiptSha256: string;
  notice: "historical_notifications_incomplete";
}
/** Acknowledged history remains visibly incomplete after every future state save. */
export function hasHistoricalOutputGap(value: unknown): boolean {
  const state = value as
    | {
        outputHistoryRecovery?: OutputHistoryRecoveryRecord;
        outputJournalBinding?: { anchorName?: string };
        outputJournalHead?: { name?: string };
      }
    | undefined;
  const record = state?.outputHistoryRecovery;
  const hex = /^[a-f0-9]{64}$/;
  return (
    !!record &&
    record.version === 1 &&
    record.historicalGap === true &&
    typeof record.recoveryId === "string" &&
    /^[a-f0-9-]{36}$/.test(record.recoveryId) &&
    typeof record.planId === "string" &&
    /^[a-f0-9-]{36}$/.test(record.planId) &&
    record.notice === "historical_notifications_incomplete" &&
    Number.isFinite(Date.parse(record.acceptedAt)) &&
    state?.outputJournalBinding?.anchorName === `output-journal-${record.recoveryId}.jsonl` &&
    state?.outputJournalHead?.name === `output-journal-head-${record.recoveryId}.json` &&
    hex.test(record.sourceJournalSha256) &&
    hex.test(record.transcriptSha256) &&
    hex.test(record.receiptSha256)
  );
}
