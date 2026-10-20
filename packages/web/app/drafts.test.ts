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
    expect(drafts.restore(submitted)).toBe("restored");
    expect(drafts.get("s1")).toMatchObject({ text: " original task \n", files: [file] });
    expect(drafts.restore(submitted)).toBe(false);
  });

  test("a late failure keeps both its own text and newer typing, never overwriting either", () => {
    const drafts = new SessionDrafts();
    drafts.setText("s1", "old task");
    drafts.addFile("s1", file);
    const submitted = drafts.take("s1");
    const later = { ...file, id: "upload-2", name: "later.txt" };
    drafts.setText("s1", "new task");
    drafts.addFile("s1", later);
    expect(drafts.restore(submitted)).toBe("merged");
    expect(drafts.get("s1")).toMatchObject({
      text: "old task\n\nnew task",
      files: [file, later],
    });
    expect(drafts.restore(submitted)).toBe(false);
  });

  test("a failure after the composer was edited back to empty still returns the task", () => {
    const drafts = new SessionDrafts();
    drafts.setText("s1", "old task");
    const submitted = drafts.take("s1");
    drafts.setText("s1", "typed");
    drafts.setText("s1", "");
    expect(drafts.restore(submitted)).toBe("restored");
    expect(drafts.get("s1").text).toBe("old task");
  });

  test("recovery follows its original session while another session is edited", () => {
    const drafts = new SessionDrafts();
    drafts.setText("s1", "task one");
    const submitted = drafts.take("s1");
    drafts.setText("s2", "task two");
    drafts.addFile("s2", file);
    expect(drafts.restore(submitted)).toBe("restored");
    expect(drafts.get("s1").text).toBe("task one");
    expect(drafts.get("s2")).toMatchObject({ text: "task two", files: [file] });
  });

  test("an async upload is bound to its originating session and survives a late restoration", () => {
    const drafts = new SessionDrafts();
    drafts.setText("s1", "task one");
    const submitted = drafts.take("s1");
    drafts.addFile("s1", file);
    expect(drafts.get("s2").files).toHaveLength(0);
    expect(drafts.restore(submitted)).toBe("merged");
    expect(drafts.get("s1")).toMatchObject({ text: "task one", files: [file] });
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
