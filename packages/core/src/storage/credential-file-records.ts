/** Opaque metadata shared by the sealed-file reader and the Link cleanup queue. */
export const retirementRecordType = "remote-link-retirement";
export function retirementCount(records: readonly unknown[]): number {
  return records.filter(
    (record) => (record as { type?: unknown } | null)?.type === retirementRecordType,
  ).length;
}
