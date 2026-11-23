import type { PetAttentionEvent, PetAttentionSnapshot } from "../main/pet/pet-notice-types.js";

export type AttentionReceipt = {
  key: string;
  state: "seen" | "dismissed" | "surfaced" | "suppressed-active";
};
export type AttentionReceiptWrite =
  | { type: "claim"; rows: AttentionReceipt[] }
  | { type: "mark"; rows: AttentionReceipt[] };
export interface MimiAttentionOperations {
  "mimi/attentionStart": {
    input: { active: string | null; revision: number };
    result: PetAttentionSnapshot;
  };
  "mimi/attentionSnapshot": { input: Record<string, never>; result: PetAttentionSnapshot };
  "mimi/attentionActive": { input: { active: string | null; revision: number }; result: void };
  "mimi/attentionMark": { input: { keys: string[]; state: "seen" | "dismissed" }; result: void };
}
export type { PetAttentionEvent, PetAttentionSnapshot };
