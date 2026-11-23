import { randomBytes } from "node:crypto";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
type Source = { kind: "zip" | "dir"; path: string };
type Review = Source & { digest: string; expires: number };

/** The content digest proves the bytes; an independent nonce identifies the
 * document which reviewed that source. A collision keeps its overwrite confirmation. */
export function reviewedLocalPlugins(call: CallShellBusiness) {
  const documents = new WeakMap<AbortSignal, Map<string, Review>>();
  return {
    async preview(input: Source, signal: AbortSignal) {
      const result = await call(
        "plugins/previewLocal",
        { kind: input.kind, path: input.path },
        signal,
      );
      if (!result.ok) return result;
      signal.throwIfAborted();
      const reviews = documents.get(signal) ?? new Map<string, Review>();
      documents.set(signal, reviews);
      while (reviews.size >= 16) reviews.delete(reviews.keys().next().value!);
      const token = randomBytes(32).toString("hex");
      reviews.set(token, {
        kind: input.kind,
        path: input.path,
        digest: result.preview.reviewToken,
        expires: Date.now() + 10 * 60_000,
      });
      return { ...result, preview: { ...result.preview, reviewToken: token } };
    },
    async install(
      input: Source & { reviewToken: string; overwrite?: boolean },
      signal: AbortSignal,
    ) {
      const reviews = documents.get(signal);
      const review = reviews?.get(input.reviewToken);
      if (
        !review ||
        review.expires <= Date.now() ||
        review.path !== input.path ||
        review.kind !== input.kind
      )
        throw Error("Local plugin review expired; choose the plugin again");
      if (input.overwrite !== undefined && typeof input.overwrite !== "boolean")
        throw Error("Invalid plugin overwrite option");
      reviews!.delete(input.reviewToken);
      const result = await call(
        "plugins/installLocal",
        {
          kind: review.kind,
          path: review.path,
          reviewToken: review.digest,
          overwrite: input.overwrite,
        },
        signal,
      );
      if (
        !result.ok &&
        "alreadyInstalled" in result &&
        result.alreadyInstalled &&
        !input.overwrite &&
        !signal.aborted &&
        reviews!.size < 16
      )
        reviews!.set(input.reviewToken, review);
      return result;
    },
  };
}
