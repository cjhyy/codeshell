import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MAX_STAGED_IMAGE_BYTES,
  listRecentAttachments,
  markAttachmentsSent,
  stageImageBytes,
  type InputAttachmentMeta,
} from "@cjhyy/code-shell-server/storage";
import { buildInputAttachmentContext } from "../../../../core/src/engine/input-attachments.js";
import { preparePetDelegationAttachments } from "./pet-delegation-attachments.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("Mimi delegated image custody", () => {
  let root: string;
  let managerCwd: string;
  let workCwd: string;
  let image: InputAttachmentMeta;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "pet-image-handoff-")));
    managerCwd = join(root, "no-repo");
    workCwd = join(root, "workspace");
    await Promise.all([mkdir(managerCwd), mkdir(workCwd)]);
    image = await stageImageBytes({
      cwd: managerCwd,
      sessionId: "pet-manager",
      name: "wechat screenshot.png",
      mime: "image/png",
      bytes: png,
      origin: "im-gateway",
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const prepare = (task: string, cwd: string, attachment: InputAttachmentMeta) =>
    preparePetDelegationAttachments({
      task,
      cwd,
      sessionId: "pet-work-target",
      inputAttachments: { cwd: managerCwd, sessionId: "pet-manager", attachments: [attachment] },
    });

  test("transfers a persisted earlier image into the target Session that Core can actually read", async () => {
    await markAttachmentsSent(managerCwd, "pet-manager", [image]);
    const [remembered] = await listRecentAttachments({ cwd: managerCwd, sessionId: "pet-manager" });
    expect(remembered?.absPath).toBe(image.absPath);
    const task = `Read the earlier screenshot ${image.path} and diagnose its error`;
    const prepared = await prepare(task, workCwd, remembered!);
    const [transferred] = prepared.attachments;
    expect(transferred).toMatchObject({ sessionId: "pet-work-target", kind: "image" });
    expect(dirname(transferred!.absPath)).toBe(
      join(workCwd, ".code-shell", "attachments", "pet-work-target"),
    );
    expect(transferred!.absPath).not.toBe(image.absPath);
    expect(await readFile(transferred!.absPath)).toEqual(await readFile(image.absPath));
    expect(prepared.task).toContain("<host-transferred-input-images>");
    expect(prepared.task).toContain(transferred!.absPath);
    const rejectedOld = await buildInputAttachmentContext([image], workCwd, {
      expectedSessionId: "pet-work-target",
    });
    expect(rejectedOld.errors.join("\n")).toContain("session mismatch");
    const context = await buildInputAttachmentContext(prepared.attachments, workCwd, {
      expectedSessionId: "pet-work-target",
    });
    expect(context.errors).toEqual([]);
    expect(context.images).toHaveLength(1);
    expect(context.images[0]!.base64).toBe((await readFile(image.absPath)).toString("base64"));
  });

  test("accepts a source root reached through a host symlink, since staging records canonical paths", async () => {
    const alias = join(root, "home-alias");
    await symlink(managerCwd, alias, "dir");
    const prepared = await preparePetDelegationAttachments({
      task: `Read ${image.path}`,
      cwd: workCwd,
      sessionId: "pet-work-target",
      inputAttachments: { cwd: alias, sessionId: "pet-manager", attachments: [image] },
    });
    expect(prepared.attachments).toHaveLength(1);
    expect(await readFile(prepared.attachments[0]!.absPath)).toEqual(png);
  });

  test("leaves ordinary delegation independent of filesystem attachment storage", async () => {
    expect(
      await preparePetDelegationAttachments({
        task: "inspect code",
        cwd: "/absent",
        sessionId: "work",
      }),
    ).toEqual({ task: "inspect code", attachments: [] });
  });

  test("deduplicates the same selected image", async () => {
    const prepared = await preparePetDelegationAttachments({
      task: "inspect screenshot",
      cwd: workCwd,
      sessionId: "pet-work-target",
      inputAttachments: {
        cwd: managerCwd,
        sessionId: "pet-manager",
        attachments: [image, image],
      },
    });
    expect(prepared.attachments).toHaveLength(1);
  });

  test("rewrites exact source aliases once without corrupting guessed paths or lookalike filenames", async () => {
    const task = [
      `Read \`${image.path}\` or "${image.absPath}".`,
      `A different file: ${image.path}.backup`,
      `A guessed location: /not-the-source/${image.path}`,
    ].join("\n");
    const prepared = await prepare(task, workCwd, image);
    const target = prepared.attachments[0]!.absPath;
    expect(prepared.task).toContain(`Read \`${target}\` or "${target}".`);
    expect(prepared.task).toContain(`A different file: ${image.path}.backup`);
    expect(prepared.task).toContain(`A guessed location: /not-the-source/${image.path}`);
    expect(prepared.task).not.toContain(`/not-the-source/${target}`);
  });

  test("rejects an image belonging to another source Session", async () => {
    await expect(
      prepare("inspect screenshot", workCwd, { ...image, sessionId: "other" }),
    ).rejects.toThrow("invalid selected image metadata");
  });

  test("rejects a forged source outside the exact source Session directory", async () => {
    const outside = join(managerCwd, "private.png");
    await writeFile(outside, await readFile(image.absPath));
    await expect(
      prepare("inspect screenshot", workCwd, { ...image, absPath: outside }),
    ).rejects.toThrow("outside its source Session");
  });

  test("rejects a selected image that disappeared instead of launching without pixels", async () => {
    await rm(image.absPath);
    await expect(prepare("inspect screenshot", workCwd, image)).rejects.toThrow();
  });

  test("rejects same-length tampering before creating a target attachment", async () => {
    const changed = await readFile(image.absPath);
    changed[changed.length - 1] ^= 1;
    await writeFile(image.absPath, changed);
    await expect(prepare("inspect screenshot", workCwd, image)).rejects.toThrow("staged content");
    expect(await listRecentAttachments({ cwd: workCwd, sessionId: "pet-work-target" })).toEqual([]);
  });

  test("rejects a tampered preexisting target instead of trusting its staged hash-prefix filename", async () => {
    const first = await prepare("inspect screenshot", workCwd, image);
    const target = first.attachments[0]!;
    const changed = await readFile(target.absPath);
    changed[changed.length - 1] ^= 1;
    await writeFile(target.absPath, changed);
    await expect(prepare("inspect the same screenshot again", workCwd, image)).rejects.toThrow(
      "staged content",
    );
    expect(await readFile(image.absPath)).toEqual(png);
  });

  test("rejects a file that grew and metadata that exceeds the bounded read limit", async () => {
    await appendFile(image.absPath, "extra");
    await expect(prepare("inspect screenshot", workCwd, image)).rejects.toThrow(
      "changed before reading",
    );
    await expect(
      prepare("inspect screenshot", workCwd, { ...image, size: MAX_STAGED_IMAGE_BYTES + 1 }),
    ).rejects.toThrow("invalid selected image metadata");
  });

  test("does not follow a replacement source file symlink", async () => {
    const saved = join(root, "saved.png");
    await rename(image.absPath, saved);
    await symlink(saved, image.absPath);
    await expect(prepare("inspect screenshot", workCwd, image)).rejects.toThrow("regular file");
  });

  test("does not follow a replacement source staging directory symlink", async () => {
    const original = dirname(image.absPath);
    const moved = join(root, "moved-source");
    await rename(original, moved);
    await symlink(moved, original, "dir");
    await expect(prepare("inspect screenshot", workCwd, image)).rejects.toThrow(
      "directory changed",
    );
  });
});
