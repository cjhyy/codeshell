import { describe, expect, test } from "bun:test";
import { SessionDrafts } from "./drafts.js";

const file = {
  id: "upload-1",
  name: "notes.txt",
  mimeType: "text/plain",
  size: 12,
  path: "upload-1",
};

describe("per-session draft recovery", () => {
  test("restores a rejected submission's original text and attachments exactly once", () => {
    const drafts = new SessionDrafts();
    drafts.setText("s1", " original task \n");
    drafts.addFile("s1", file);
    const submitted = drafts.take("s1");
    expect(drafts.get("s1")).toMatchObject({ text: "", files: [] });
    expect(drafts.restore(submitted)).toBe(true);
    expect(drafts.get("s1")).toMatchObject({ text: " original task \n", files: [file] });
    expect(drafts.restore(submitted)).toBe(false);
  });

  test("a late failure never overwrites newly typed text or an intentional edit back to empty", () => {
    const drafts = new SessionDrafts();
    drafts.setText("s1", "old task");
    const submitted = drafts.take("s1");
    drafts.setText("s1", "new task");
    expect(drafts.restore(submitted)).toBe(false);
    drafts.setText("s1", "");
    expect(drafts.restore(submitted)).toBe(false);
    expect(drafts.get("s1").text).toBe("");
  });

  test("recovery follows its original session while another session is edited", () => {
    const drafts = new SessionDrafts();
    drafts.setText("s1", "task one");
    const submitted = drafts.take("s1");
    drafts.setText("s2", "task two");
    drafts.addFile("s2", file);
    expect(drafts.restore(submitted)).toBe(true);
    expect(drafts.get("s1").text).toBe("task one");
    expect(drafts.get("s2")).toMatchObject({ text: "task two", files: [file] });
  });

  test("an async upload is bound to its originating session and blocks stale restoration", () => {
    const drafts = new SessionDrafts();
    drafts.setText("s1", "task one");
    const submitted = drafts.take("s1");
    drafts.addFile("s1", file);
    expect(drafts.get("s2").files).toHaveLength(0);
    expect(drafts.restore(submitted)).toBe(false);
    expect(drafts.get("s1").files).toEqual([file]);
  });

  test("unsent drafts remain discoverable after switching away and vanish when consumed", () => {
    const drafts = new SessionDrafts();
    drafts.setText("s1", "first draft");
    drafts.addFile("s2", file);
    expect(drafts.unsent().map((entry) => entry.sessionId)).toEqual(["s1", "s2"]);
    drafts.take("s1");
    drafts.removeFile("s2", file.id);
    expect(drafts.unsent()).toEqual([]);
  });
});
