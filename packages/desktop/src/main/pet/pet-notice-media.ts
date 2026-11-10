import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { isNoticeRecordId } from "./pet-notice-ledger.js";
import {
  errorText,
  MAX_NOTICE_ATTACHMENT_BYTES,
  MAX_NOTICE_ATTACHMENTS,
  type NoticeMedia,
  type NoticeMediaAttachment,
  type NoticeMediaFreezer,
} from "./pet-notice-types.js";

const SAFE_EXTENSION = /^\.[A-Za-z0-9]{1,16}$/u;

export interface PetNoticeMediaStoreOptions {
  /** `<userData>/pet/notice-media`; one folder per ledger record. */
  root: string;
  log?: (event: string, data: Record<string, unknown>) => void;
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * `<root>/<recordId>/<n><ext>`: the frozen files of one ledger record. The
 * router deletes a folder once its record can no longer be sent, and sweeps
 * folders of records that are gone at startup.
 */
export class PetNoticeMediaStore implements NoticeMediaFreezer {
  private readonly log: (event: string, data: Record<string, unknown>) => void;

  constructor(private readonly options: PetNoticeMediaStoreOptions) {
    this.log = options.log ?? (() => undefined);
  }

  folder(recordId: string): string {
    if (!isNoticeRecordId(recordId)) throw new Error("invalid notice record id");
    return join(this.options.root, recordId);
  }

  async freeze(recordId: string, media: NoticeMedia): Promise<NoticeMedia | undefined> {
    const sources = (media.attachments ?? []).slice(0, MAX_NOTICE_ATTACHMENTS);
    const textOnly = media.button ? { button: media.button } : undefined;
    if (sources.length === 0) return textOnly;
    try {
      const folder = this.folder(recordId);
      await mkdir(folder, { recursive: true });
      const attachments: NoticeMediaAttachment[] = [];
      for (const [index, source] of sources.entries()) {
        const before = await stat(source.path);
        if (!before.isFile()) throw new Error("not a regular file");
        if (before.size > MAX_NOTICE_ATTACHMENT_BYTES) throw new Error("file too large");
        const extension = extname(source.name);
        const copy = join(folder, `${index}${SAFE_EXTENSION.test(extension) ? extension : ""}`);
        await copyFile(source.path, copy);
        // The source may have changed between the check and the copy: the copy decides.
        const size = (await stat(copy)).size;
        if (size < 1 || size > MAX_NOTICE_ATTACHMENT_BYTES)
          throw new Error("file size out of range");
        attachments.push({
          kind: source.kind,
          name: source.name,
          mimeType: source.mimeType,
          size,
          path: copy,
          sha256: await sha256Of(copy),
        });
      }
      return { attachments, ...(media.button ? { button: media.button } : {}) };
    } catch (error) {
      this.log("pet.notice.media_freeze_failed", {
        files: sources.length,
        error: errorText(error),
      });
      await this.release(recordId);
      return textOnly;
    }
  }

  async release(recordId: string): Promise<void> {
    if (!isNoticeRecordId(recordId)) return;
    try {
      await rm(this.folder(recordId), { recursive: true, force: true });
    } catch (error) {
      this.log("pet.notice.media_release_failed", { error: errorText(error) });
    }
  }

  async sweep(keep: (recordId: string) => boolean): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.options.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.log("pet.notice.media_sweep_failed", { error: errorText(error) });
      return;
    }
    for (const name of names) {
      // Only folders this store made; anything else in the directory is left alone.
      if (isNoticeRecordId(name) && !keep(name)) await this.release(name);
    }
  }
}
