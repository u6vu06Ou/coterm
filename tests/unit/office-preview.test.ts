import { zipSync } from "fflate";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { parsePresentation, parseSpreadsheet } from "../../src/main/core/office-preview";

describe("office preview parsers", () => {
  it("reads multiple workbook sheets and keeps displayed formula values bounded", () => {
    const workbook = XLSX.utils.book_new();
    const first = XLSX.utils.aoa_to_sheet([["姓名", "值"], ["maintainer", 42], ["合計", { f: "B2*2", v: 84 }]]);
    const second = XLSX.utils.aoa_to_sheet([["第二頁"], [new Date("2026-01-02T00:00:00.000Z")]]);
    XLSX.utils.book_append_sheet(workbook, first, "中文資料");
    XLSX.utils.book_append_sheet(workbook, second, "第二頁");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", cellDates: true }) as Buffer;
    const model = parseSpreadsheet(bytes, ".xlsx");
    expect(model.sheets.map((sheet) => sheet.name)).toEqual(["中文資料", "第二頁"]);
    expect(model.sheets[0]?.cells).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 1, column: 0, value: "maintainer" }),
      expect.objectContaining({ row: 2, column: 1, formula: "B2*2" }),
    ]));
  });

  it("parses CSV and TSV through the same read-only grid model", () => {
    expect(parseSpreadsheet(Buffer.from("a,b\n1,2\n"), ".csv").format).toBe("csv");
    expect(parseSpreadsheet(Buffer.from("a\tb\n1\t2\n"), ".tsv").format).toBe("tsv");
  });

  it("renders basic PPTX text and gives malformed archives a safe error", () => {
    const archive = zipSync({
      "ppt/presentation.xml": Buffer.from(`<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="12192000" cy="6858000"/><p:sldIdLst><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>`),
      "ppt/_rels/presentation.xml.rels": Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`),
      "ppt/slides/slide1.xml": Buffer.from(`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5000000" cy="800000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>中文投影片</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
    });
    const model = parsePresentation(Buffer.from(archive));
    expect(model.slides[0]?.elements).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "text", text: "中文投影片" })]));
    expect(() => parsePresentation(Buffer.from("not a pptx"))).toThrow(/Malformed PPTX/);
  });
});
