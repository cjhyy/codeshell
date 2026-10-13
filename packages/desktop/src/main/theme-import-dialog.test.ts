import { describe, expect, test } from "bun:test";
import { themeImportDialogOptions } from "./theme-import-dialog";

describe("theme import native dialog", () => {
  test("defaults to one ZIP file with a ZIP filter", () => {
    expect(themeImportDialogOptions()).toEqual(themeImportDialogOptions("zip"));
    expect(themeImportDialogOptions("zip")).toMatchObject({
      properties: ["openFile"],
      filters: [{ extensions: ["zip"] }],
    });
  });

  test("folder imports use a separate directory chooser without a file filter", () => {
    const options = themeImportDialogOptions("directory");
    expect(options.properties).toEqual(["openDirectory"]);
    expect(options.filters).toBeUndefined();
  });

  test("rejects malformed renderer requests before opening a native dialog", () => {
    for (const input of [null, "file", "", 1, {}, ["zip"]]) {
      expect(() => themeImportDialogOptions(input)).toThrow("requires zip or directory");
    }
  });
});
