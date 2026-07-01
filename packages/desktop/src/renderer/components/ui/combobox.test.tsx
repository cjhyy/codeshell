import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Combobox } from "./combobox";

const OPTS = [
  { value: "a", label: "Apple" },
  { value: "b", label: "Banana" },
];

describe("Combobox", () => {
  test("trigger shows the current option's label", () => {
    const html = renderToStaticMarkup(
      <Combobox options={OPTS} value="b" onChange={() => {}} placeholder="pick" />,
    );
    expect(html).toContain("Banana");
  });

  test("shows placeholder when value has no matching option", () => {
    const html = renderToStaticMarkup(
      <Combobox options={OPTS} value="zzz" onChange={() => {}} placeholder="pick one" />,
    );
    expect(html).toContain("pick one");
  });
});
