import type { RendererMemoryEntry, SaveMemoryInput, MemoryLevel } from "../preload/types";
import type {
  ProfileMemoryPromotionReview,
  ProfileMemoryPromotionResult,
  PreviewProfileMemoryPromotionInput,
  CommitProfileMemoryPromotionInput,
} from "./profile-memory-promotion.js";
export type MemorySelection = {
  level: MemoryLevel;
  scope: "user" | "dream" | "pending";
  cwd?: string;
  profileName?: string;
};
export interface MemoryReads {
  "memory/list": { params: MemorySelection; result: RendererMemoryEntry[] };
  "memory/read": {
    params: MemorySelection & { name: string };
    result: (RendererMemoryEntry & { content: string }) | null;
  };
  "memory/pending": {
    params: Record<string, never>;
    result: (RendererMemoryEntry & { content: string })[];
  };
}
export interface MemoryOperations {
  "memory/save": { input: SaveMemoryInput; result: string };
  "memory/delete": { input: MemorySelection & { name: string }; result: boolean };
  "memory/approve": { input: { name: string }; result: string | null };
  "memory/demote": { input: { name: string }; result: string | null };
  "memory/reject": { input: { name: string }; result: boolean };
  "memory/promote": { input: { cwd: string; name: string }; result: string | null };
  "memory/previewProfilePromotion": {
    input: { owner: number; value: PreviewProfileMemoryPromotionInput };
    result: ProfileMemoryPromotionReview;
  };
  "memory/commitProfilePromotion": {
    input: { owner: number; value: CommitProfileMemoryPromotionInput };
    result: ProfileMemoryPromotionResult;
  };
  "memory/discardProfilePromotion": { input: { owner: number }; result: void };
  "memory/dream": {
    input: { level: "user" | "project"; cwd?: string };
    result: { ran: boolean; summary: string };
  };
}
export type PrivateMemoryReads = {
  [K in keyof MemoryReads]: { input: MemoryReads[K]["params"]; result: MemoryReads[K]["result"] };
};
