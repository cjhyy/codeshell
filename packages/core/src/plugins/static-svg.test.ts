import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PLUGIN_COMPOSER_SVG_LIMITS as LIMITS, validatePluginComposerSvg } from "./static-svg.js";

const start = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"';
const svg = (body = '<path d="M0 0L10 10z"/>', attributes = "") =>
  `${start}${attributes}>${body}</svg>`;
const check = (xml: string) => validatePluginComposerSvg(Buffer.from(xml));

describe("static plugin composer SVG", () => {
  test("accepts the unchanged official Superpowers6.1.1 composer asset", () => {
    // obra/superpowers d884ae04edebef577e82ff7c4e143debd0bbec99, assets/superpowers-small.svg.
    const original =
      '<?xml version="1.0" encoding="UTF-8"?><svg id="Calque_1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M394.28,207.8c.81,2.41,1.39,4.78,1.8,7.07,1.61,9.03-.93,17.78-5.99,21.74-22.6,17.7-49.85,29.35-75.34,38.6-.59.22-1.09.28-1.4.34-2.22.47-4.95,1.04-7.25,0-1.46-.66-2.25-1.74-2.66-2.3-1.56-2.1-1.59-4.31-1.56-5.13.1-2.67-.01-4.69,0-4.82.45-3.52.91-10.66,1.41-21.28.6-3.87,2.16-9.63,6.94-13.96,4.01-3.62,8.33-4.6,14.59-5.87,10.76-2.19,37.21-8.22,47.42-16.56,1.63-1.33,2.97-2.65,4.19-3.96,3.72-3.99,6.39-7.92,7.93-10.36,3.22,3.22,7.25,8.48,9.92,16.47Z"/><path d="M428.67,185.28c-2.33,11.99-8.91,22.32-15.88,30.38.27-5.5-.05-12.11-1.86-19.08-5.04-19.36-19.74-34.7-37.78-37.78-32.21-9.74-70.59,3.79-99.08,18.29-3.87,1.95-9.52-2.77-11.84-8.16-3.32-7.71-1.63-6.28,2.61-8.49,38.31-20.03,82.01-39.61,123.91-29.7,8.26,1.95,15.96,5.26,23.48,10.54,11.32,7.96,20.21,24.74,16.44,44Z"/><path d="M117.72,304.2c-.81-2.41-1.39-4.78-1.8-7.07-1.61-9.03.93-17.78,5.99-21.74,22.6-17.7,49.85-29.35,75.34-38.6.59-.22,1.09-.28,1.4-.34,2.22-.47,4.95-1.04,7.25,0,1.46.66,2.25,1.74,2.66,2.3,1.56,2.1,1.59,4.31,1.56,5.13-.1,2.67.01,4.69,0,4.82-.45,3.52-.91,10.66-1.41,21.28-.6,3.87-2.16,9.63-6.94,13.96-4.01,3.62-8.33,4.6-14.59,5.87-10.76,2.19-37.21,8.22-47.42,16.56-1.63,1.33-2.97,2.65-4.19,3.96-3.72,3.99-6.39,7.92-7.93,10.36-3.22-3.22-7.25-8.48-9.92-16.47Z"/><path d="M83.33,326.72c2.33-11.99,8.91-22.32,15.88-30.38-.27,5.5.05,12.11,1.86,19.08,5.04,19.36,19.74,34.7,37.78,37.78,32.21,9.74,70.59-3.79,99.08-18.29,3.87-1.95,9.52,2.77,11.84,8.16,3.32,7.71,1.63,6.28-2.61,8.49-38.31,20.03-82.01,39.61-123.91,29.7-8.26-1.95-15.96-5.26-23.48-10.54-11.32-7.96-20.21-24.74-16.44-44Z"/><ellipse cx="255.16" cy="258.86" rx="28.95" ry="28.76"/></svg>';
    expect(createHash("sha256").update(original).digest("hex")).toBe(
      "54a632d9ee6197ccbc10d43d42217e23d08375bea63ba8eb4b6af757c1535038",
    );
    expect(check(original)).toEqual({ width: 512, height: 512 });
  });
  test("accepts bounded static shapes, an optional genuine XML declaration and finite path grammar", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      svg(
        '<g id="shapes" fill="#f03" stroke="currentColor" opacity="0.5">' +
          '<path d="M0 0 1 1l1-1h1v1C1 2 3 4 5 6s1 2 3 4Q1 2 3 4t1 2A3 4 45 0 1 10 20z"/>' +
          '<ellipse cx="255.16" cy="258.86" rx="28.95" ry="28.76"/>' +
          '<circle r="2"/><rect width="2" height="3" rx="1"/>' +
          '<line x1="0" y1="1" x2="2" y2="3"/>' +
          '<polyline points="0,0 1,1"/><polygon points="0 0 1 0 1 1"/></g>',
        ' id="Calque_1" width="512px" height="512" preserveAspectRatio="xMidYMid meet"',
      );
    expect(check(xml)).toEqual({ width: 512, height: 512 });
    expect(check(svg('<path d="M1e2 .5c.81,2.41,1.39,4.78,1.8,7.07Z"/>'))).toEqual({
      width: 512,
      height: 512,
    });
  });

  test("rejects active or resource elements, all foreign namespaces and nested documents", () => {
    for (const element of [
      "script",
      "foreignObject",
      "use",
      "image",
      "a",
      "text",
      "animate",
      "animateTransform",
      "set",
      "style",
      "defs",
      "filter",
      "mask",
      "pattern",
      "clipPath",
      "svg",
    ]) {
      expect(() => check(svg(`<${element}/>`))).toThrow();
    }
    for (const xml of [
      '<svg viewBox="0 0 1 1"/>',
      '<svg xmlns="http://example.com" viewBox="0 0 1 1"/>',
      '<s:svg xmlns:s="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
      svg('<x:path xmlns:x="http://www.w3.org/2000/svg" d="M0 0"/>'),
      svg('<g xmlns="http://www.w3.org/2000/svg"/>'),
      svg('<path xmlns="http://example.com" d="M0 0"/>'),
      svg('<path d="M0 0"><g/></path>'),
      svg("", ' xmlns:xlink="http://www.w3.org/1999/xlink"'),
      svg("", ' xml:base="https://example.com/"'),
    ])
      expect(() => check(xml)).toThrow();
  });

  test("refuses attributes and paint outside its closed static grammar", () => {
    for (const attr of [
      'onload="alert(1)"',
      'ONLOAD="alert(1)"',
      'style="fill:red"',
      'class="x"',
      'href="https://example.com/x"',
      'xlink:href="https://example.com/x"',
      'src="file:///secret"',
      'transform="scale(2)"',
      'fill="url(#x)"',
      'fill="url(https://example.com/x)"',
      'fill="var(--x)"',
      'fill="r\\65 d"',
      'opacity="1.1"',
      'stroke-width="8193"',
      'stroke-miterlimit="1001"',
      'id="../../secret"',
    ])
      expect(() => check(svg(`<path d="M0 0" ${attr}/>`))).toThrow();
  });

  test("rejects declarations, entities, malformed XML and non UTF-8 input", () => {
    for (const xml of [
      '<!DOCTYPE svg SYSTEM "https://example.com/x">' + svg(),
      '<!DOCTYPE svg [<!ENTITY x "test">]>' + svg("&x;"),
      '<?xml-stylesheet href="https://example.com/x"?>' + svg(),
      "<?anything x?>" + svg(),
      '<?xml version="1.1"?>' + svg(),
      '<?xml version="1.0" encoding="UTF-16"?>' + svg(),
      svg("<!--comment-->"),
      svg("<![CDATA[<script/>]]>"),
      svg("text"),
      svg("", ' id="&#65;"'),
      svg("", ' id="&amp;"'),
      svg("", ' id="&custom;"'),
      svg("", ' id="one" id="two"'),
      svg() + svg(),
      svg().slice(0, -3),
      svg("\u0000"),
    ])
      expect(() => check(xml)).toThrow();
    expect(() => validatePluginComposerSvg(Uint8Array.from([0xc0, 0x80]))).toThrow();
  });

  test("consumes complete path and number grammar including arc arity and flags", () => {
    for (const d of [
      "",
      "Z",
      "L0 0",
      "M",
      "M0",
      "M0 0L1",
      "M0 0R1 2",
      "M0 0Z1 2",
      "M0 0,",
      "M,0 0",
      "M0,,0",
      "MNaN 0",
      "MInfinity 0",
      "M1e309 0",
      "M1000001 0",
      "M0 0A1 1 0 2 0 1 1",
      "M0 0A-1 1 0 0 1 1 1",
      "M0 0A8193 1 0 0 1 1 1",
      "M0 0A1 1 0 0.0 1 1 1",
      "M0 0l1px 1",
    ]) {
      expect(() => check(svg(`<path d="${d}"/>`))).toThrow();
    }
    expect(() => check(svg(`<path d="M${"0".repeat(65)} 0"/>`))).toThrow();
    expect(() => check(svg('<polyline points="0 0 1"/>'))).toThrow();
    expect(() => check(svg('<polygon points="0 0 1 1"/>'))).toThrow();
  });

  test("bounds bytes, structure and viewports at their declared limits", () => {
    const minimal = svg();
    const full = minimal + " ".repeat(LIMITS.bytes - Buffer.byteLength(minimal));
    expect(check(full).width).toBe(512);
    expect(() => check(full + " ")).toThrow(/byte limit/);
    expect(() => validatePluginComposerSvg(new Uint8Array())).toThrow();
    expect(check(svg("<g>".repeat(15) + "</g>".repeat(15))).width).toBe(512);
    expect(() => check(svg("<g>".repeat(16) + "</g>".repeat(16)))).toThrow(/structure limit/);
    expect(check(svg("<circle/>".repeat(1023))).width).toBe(512);
    expect(() => check(svg("<circle/>".repeat(1024)))).toThrow(/structure limit/);
    for (const viewBox of [
      "0 0 0 1",
      "0 0 -1 1",
      "0 0 8193 1",
      "0 0 8192 8192",
      "0 0 1",
      "0 0 Infinity 1",
    ]) {
      expect(() => check(svg().replace("0 0 512 512", viewBox))).toThrow();
    }
    expect(check(svg().replace("0 0 512 512", "0 0 8192 1")).width).toBe(8192);
    expect(() => check(svg("", ' width="8193"'))).toThrow();
    expect(() => check(svg("", ' width="8000" height="8000"'))).toThrow();
    expect(() => check(svg("", ' width="100%"'))).toThrow();
    expect(check(svg("", ' width="256"'))).toEqual({ width: 256, height: 256 });
    expect(check(svg("", ' height="128"'))).toEqual({ width: 128, height: 128 });
    expect(() => check(svg("", ' width="1"').replace("0 0 512 512", "0 0 .000001 1"))).toThrow(
      /dimension/,
    );
    expect(() => check(svg("", ' height="1"').replace("0 0 512 512", "0 0 1 .000001"))).toThrow(
      /dimension/,
    );
    expect(() => check(svg("", ' width="1"').replace("0 0 512 512", "0 0 1e-320 1"))).toThrow(
      /dimension/,
    );
  });

  test("applies cumulative path, numeric and geometry budgets before rendering", () => {
    const pathAtLimit = "M0 0" + " ".repeat(LIMITS.pathCharacters - 4);
    expect(check(svg(`<path d="${pathAtLimit}"/>`)).width).toBe(512);
    expect(() => check(svg(`<path d="${pathAtLimit} "/>`))).toThrow(/path character/);
    expect(check(svg(`<path d="${pathAtLimit}"/>`.repeat(4))).width).toBe(512);
    expect(() => check(svg(`<path d="${pathAtLimit}"/>`.repeat(5)))).toThrow(/path character/);
    const fullNumbers = "M0 0" + "C0 0 0 0 0 0".repeat(1365);
    const lastNumbers = "M0 0" + "C0 0 0 0 0 0".repeat(1364) + "L0 0";
    const paths = `<path d="${fullNumbers}"/>`.repeat(3);
    expect(check(svg(paths + `<path d="${lastNumbers}"/>`)).width).toBe(512);
    expect(() => check(svg(paths + `<path d="${lastNumbers}H0"/>`))).toThrow(/number limit/);
    expect(check(svg(`<path d="M0 0${"z".repeat(16_382)}"/>`)).width).toBe(512);
    expect(() => check(svg(`<path d="M0 0${"z".repeat(16_383)}"/>`))).toThrow(/geometry/);
    const attrs =
      ' x1="0" y1="0" x2="0" y2="0" id="x" fill="none" stroke="black" opacity="1" fill-opacity="1" stroke-opacity="1" stroke-width="1" fill-rule="nonzero" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="1"';
    expect(check(svg(`<line${attrs}/>`)).width).toBe(512);
    expect(() => check(svg(`<line${attrs} unknown="1" other="1"/>`))).toThrow(/attribute limit/);
  });
});
