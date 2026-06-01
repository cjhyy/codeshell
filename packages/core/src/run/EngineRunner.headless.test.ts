import { describe, it, expect } from "bun:test";
import { buildHeadlessFlag } from "./EngineRunner.js";
import { HeadlessApprovalBackend } from "../tool-system/permission.js";

describe("EngineRunner headless decision", () => {
  it("is headless when an approvalBackend override is present", () => {
    expect(buildHeadlessFlag(new HeadlessApprovalBackend("approve-read-only"))).toBe(true);
  });

  it("is not forced headless when no override", () => {
    expect(buildHeadlessFlag(undefined)).toBe(false);
  });
});
