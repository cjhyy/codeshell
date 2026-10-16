import { expect, test } from "bun:test";
import { officeZip } from "../../../tests/fixtures/upload-documents.mjs";
import { parseDocument } from "../../../packages/core/src/sources/documents/parse.ts";

const sheet = (value: string) =>
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${value}</t></is></c></row></sheetData></worksheet>`;
const workbook = (prefix = "r") =>
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:${prefix}="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Second visible sheet" sheetId="2" ${prefix}:id="second"/><sheet name="First visible sheet" sheetId="1" ${prefix}:id="first"/></sheets></workbook>`;
const relationships = (secondTarget: string) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="first" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="second" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${secondTarget}"/></Relationships>`;

test("observation: one absolute worksheet relationship silently omits that sheet", async () => {
  const result = await parseDocument(officeZip({
    "xl/workbook.xml": workbook(),
    "xl/_rels/workbook.xml.rels": relationships("/xl/worksheets/sheet2.xml"),
    "xl/worksheets/sheet1.xml": sheet("first data"),
    "xl/worksheets/sheet2.xml": sheet("second data"),
  }), "absolute.xlsx");
  // The workbook selects both sheets, second then first. These assertions capture
  // the observed defect so a passing receipt is not confused with desired behavior.
  expect(result.parts).toEqual([{ label: "First visible sheet", text: "[A1] first data" }]);
  expect(result.truncated).toBe(false);
  console.log(JSON.stringify({ case: "absolute-xlsx", intendedOrder: ["Second visible sheet", "First visible sheet"], actual: result }));
});

test("observation: dot-relative worksheet relationship has the same silent omission", async () => {
  const result = await parseDocument(officeZip({
    "xl/workbook.xml": workbook(),
    "xl/_rels/workbook.xml.rels": relationships("./worksheets/sheet2.xml"),
    "xl/worksheets/sheet1.xml": sheet("first data"),
    "xl/worksheets/sheet2.xml": sheet("second data"),
  }), "relative.xlsx");
  expect(result.parts).toEqual([{ label: "First visible sheet", text: "[A1] first data" }]);
  expect(result.truncated).toBe(false);
  console.log(JSON.stringify({ case: "dot-relative-xlsx", intendedOrder: ["Second visible sheet", "First visible sheet"], actual: result }));
});

test("observation: absolute PPTX relationship silently omits a selected slide", async () => {
  const result = await parseDocument(officeZip({
    "ppt/presentation.xml": '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="257" r:id="second"/><p:sldId id="256" r:id="first"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="first" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="second" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/slide2.xml"/></Relationships>',
    "ppt/slides/slide1.xml": '<a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>First slide data</a:t></a:r></a:p>',
    "ppt/slides/slide2.xml": '<a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Second slide data</a:t></a:r></a:p>',
  }), "absolute.pptx");
  expect(result.parts).toEqual([{ label: "slide 1", text: "First slide data\n" }]);
  expect(result.truncated).toBe(false);
  console.log(JSON.stringify({ case: "absolute-pptx", expectedText: ["Second slide data", "First slide data"], actual: result }));
});

test("observation: namespace alias loses workbook labels and display order", async () => {
  const result = await parseDocument(officeZip({
    "xl/workbook.xml": workbook("rel"),
    "xl/_rels/workbook.xml.rels": relationships("worksheets/sheet2.xml"),
    "xl/worksheets/sheet1.xml": sheet("first data"),
    "xl/worksheets/sheet2.xml": sheet("second data"),
  }), "alias.xlsx");
  expect(result.parts.map((part) => part.label)).toEqual(["xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
  expect(result.parts.map((part) => part.text)).toEqual(["[A1] first data", "[A1] second data"]);
  expect(result.truncated).toBe(false);
  console.log(JSON.stringify({ case: "namespace-alias-xlsx", intendedOrder: ["Second visible sheet", "First visible sheet"], actual: result }));
});

test("observation: XLSX phonetic guides are concatenated into displayed strings", async () => {
  const result = await parseDocument(officeZip({
    "xl/sharedStrings.xml": '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si></sst>',
    "xl/worksheets/sheet1.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
  }), "phonetic.xlsx");
  expect(result.parts[0].text).toBe("[A1] 東京トウキョウ");
  console.log(JSON.stringify({ case: "phonetic-xlsx", expectedCellDisplay: "東京", actual: result }));
});
