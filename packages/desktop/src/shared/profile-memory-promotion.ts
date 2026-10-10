export interface ProfileMemoryPromotionDraft {
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  content: string;
  pinned?: boolean;
}

export interface PreviewProfileMemoryPromotionInput {
  cwd: string;
  source: { scope: "user" | "dream"; id: string };
  profileName: string;
  draft: ProfileMemoryPromotionDraft;
}

export interface ProfileMemoryPromotionReview {
  reviewId: string;
  expiresAt: number;
  source: Omit<ProfileMemoryPromotionDraft, "pinned"> & {
    id: string;
    scope: "user" | "dream";
  };
  target: { profileName: string; label: string; portableMemory: boolean };
  draft: ProfileMemoryPromotionDraft;
}

export interface CommitProfileMemoryPromotionInput {
  cwd: string;
  reviewId: string;
}

export interface ProfileMemoryPromotionResult {
  profileName: string;
  id: string;
  fileName: string;
}

export interface ProfileMemoryPromotionApi {
  previewProfileMemoryPromotion(
    input: PreviewProfileMemoryPromotionInput,
  ): Promise<ProfileMemoryPromotionReview>;
  commitProfileMemoryPromotion(
    input: CommitProfileMemoryPromotionInput,
  ): Promise<ProfileMemoryPromotionResult>;
}
