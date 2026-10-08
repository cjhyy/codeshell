import { expect, test } from "bun:test";
import { officeZip, textPdf, wordXml } from "../../../../../tests/fixtures/upload-documents.js";
import { parseDocument } from "./parse.js";
import { parseDocumentIsolated } from "./worker.js";
import { MAX_DOCUMENT_TEXT_BYTES } from "./types.js";

test("real DOCX ZIP parses Unicode paragraphs and predefined entities without reading external links", async () => {
  const bytes = officeZip({
    "word/document.xml": wordXml("项目计划 &amp; café"),
    "word/header1.xml": wordXml("Header"),
    "word/_rels/document.xml.rels":
      '<Relationships><Relationship Target="file:///private/secret" TargetMode="External"/></Relationships>',
    "word/vbaProject.bin": Buffer.from([0, 1, 2]),
  });
  const result = await parseDocumentIsolated(bytes, "brief.docx");
  expect(result.format).toBe("docx");
  expect(result.parts).toEqual([
    { label: "document", text: "项目计划 & café\n" },
    { label: "word/header1.xml", text: "Header\n" },
  ]);
  expect(result.truncated).toBe(false);
});

test("PPTX uses the presentation relationship order rather than sorting filenames", async () => {
  const bytes = officeZip({
    "ppt/presentation.xml":
      '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels":
      '<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>',
    "ppt/slides/slide1.xml": '<a:p xmlns:a="urn:a"><a:r><a:t>First</a:t></a:r></a:p>',
    "ppt/slides/slide2.xml": '<a:p xmlns:a="urn:a"><a:r><a:t>Second</a:t></a:r></a:p>',
  });
  const result = await parseDocumentIsolated(bytes, "deck.pptx");
  expect(result.parts.map((part) => part.text)).toEqual(["Second\n", "First\n"]);
});

test("XLSX resolves shared/rich/inline strings, numeric values and cached formulas without evaluation", async () => {
  const bytes = officeZip({
    "xl/workbook.xml":
      '<workbook xmlns:r="urn:r"><sheets><sheet name="Budget" r:id="one"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships><Relationship Id="one" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": "<sst><si><r><t>项目</t></r><r><t>预算</t></r></si></sst>",
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c><c r="C1" t="inlineStr"><is><t>Summary</t></is></c><c r="D1"><f>WEBSERVICE("https://must-not-fetch.invalid")</f><v>7</v></c></row></sheetData></worksheet>',
  });
  const result = await parseDocumentIsolated(bytes, "sheet.xlsx");
  expect(result.parts).toEqual([
    { label: "Budget", text: "[A1] 项目预算\n[B1] 42\n[C1] Summary\n[D1] 7" },
  ]);
});

test("official PDF.js actually extracts text in a bounded worker", async () => {
  const result = await parseDocumentIsolated(textPdf(), "sample.pdf");
  expect(result.format).toBe("pdf");
  expect(result.parts[0].label).toBe("page 1");
  expect(result.parts[0].text).toContain("Actual PDF text fixture");
}, 30_000);

test("malformed/encrypted/non-document and excessive archive inputs fail without extracted files", async () => {
  await expect(parseDocumentIsolated(Buffer.from("not a ZIP"), "bad.docx")).rejects.toThrow();
  await expect(
    parseDocumentIsolated(
      officeZip({
        "word/document.xml":
          '<!DOCTYPE w:document [<!ENTITY steal SYSTEM "file:///private/secret">]>' +
          wordXml("&steal;"),
      }),
      "xxe.docx",
    ),
  ).rejects.toThrow("DOCTYPE");
  await expect(
    parseDocumentIsolated(
      officeZip({
        "word/document.xml": wordXml("small"),
        "media/bomb": Buffer.alloc(33 * 1024 * 1024),
      }),
      "bomb.docx",
    ),
  ).rejects.toThrow("decompression");
  await expect(parseDocumentIsolated(Buffer.from([0, 1, 2]), "image.png")).rejects.toThrow(
    "Unsupported",
  );
  await expect(parseDocumentIsolated(Buffer.from([0xff, 0xfe]), "bad.txt")).rejects.toThrow();
}, 30_000);

test("UTF-8 extraction reports its text bound and parsing cancellation/timeout terminates workers", async () => {
  const result = await parseDocument(
    Buffer.from("界".repeat(MAX_DOCUMENT_TEXT_BYTES)),
    "large.txt",
  );
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.parts[0].text)).toBeLessThanOrEqual(MAX_DOCUMENT_TEXT_BYTES);
  const abort = new AbortController();
  const pending = parseDocumentIsolated(Buffer.from("fixture"), "cancel.txt", {
    signal: abort.signal,
  });
  abort.abort(new Error("Fixture cancelled"));
  await expect(pending).rejects.toThrow("Fixture cancelled");
  await expect(
    parseDocumentIsolated(Buffer.from("fixture"), "timeout.txt", { timeoutMs: 0 }),
  ).rejects.toThrow("time limit");
  expect(
    (await parseDocumentIsolated(Buffer.from("still available"), "next.txt")).parts[0].text,
  ).toBe("still available");
});
