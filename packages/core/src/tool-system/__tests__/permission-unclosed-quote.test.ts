import { describe, it, expect } from "bun:test";
import { classifyBashCommand } from "../permission.js";

// Regression: an unclosed quote made scanShellCommand stop recognizing
// separators/metacharacters partway through, so a command with a dangling
// quote could be misclassified as safe. We now flag unbalanced quotes as
// dangerous.
describe("classifyBashCommand — unclosed quotes", () => {
  it("flags a command with an unclosed double quote as dangerous", () => {
    expect(classifyBashCommand('echo "hello')).toBe("dangerous");
  });

  it("flags an unclosed single quote as dangerous", () => {
    expect(classifyBashCommand("echo 'hello")).toBe("dangerous");
  });

  it("flags a pipe hidden behind an unclosed quote as dangerous", () => {
    // The `|` would normally split segments; with the quote open it was
    // swallowed, hiding the pipe from classification.
    expect(classifyBashCommand('cat file | grep "pattern')).toBe("dangerous");
  });

  it("still classifies a balanced quoted command normally", () => {
    expect(classifyBashCommand('echo "a; b"')).toBe("safe-read");
  });
});
