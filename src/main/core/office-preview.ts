/* The Office parsers expose untyped XML/cell objects at this boundary. All
 * resulting data is immediately normalized into the shared bounded schemas. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
import { unzipSync } from "fflate";
import * as XLSX from "xlsx";
import { XMLParser } from "fast-xml-parser";
import type {
  PresentationModel,
  PresentationSlide,
  SpreadsheetModel,
  SpreadsheetSheet,
} from "../../shared/types";

const MAX_SHEETS = 32;
const MAX_ROWS = 200;
const MAX_COLUMNS = 50;
const MAX_SLIDES = 100;
const MAX_ELEMENTS_PER_SLIDE = 500;
const MAX_IMAGE_BYTES = 8_000_000;

type XmlNode = Record<string, unknown>;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: false,
});

export function parseSpreadsheet(bytes: Buffer, extension: string): SpreadsheetModel {
  if (bytes.length > 25_000_000) throw new Error("Spreadsheet exceeds the 25 MB preview limit.");
  const workbook = XLSX.read(bytes, {
    type: "buffer",
    cellDates: true,
    cellFormula: true,
    bookVBA: false,
    bookDeps: false,
    cellStyles: false,
  });
  const names = workbook.SheetNames.slice(0, MAX_SHEETS);
  if (workbook.SheetNames.length > MAX_SHEETS) throw new Error(`Workbook has more than ${MAX_SHEETS} sheets.`);
  const sheets = names.map((name, index) => {
    const sheet = workbook.Sheets[name];
    if (!sheet) throw new Error(`Workbook sheet is unavailable: ${name}.`);
    return parseSheet(sheet, name, index);
  });
  return {
    format: extension === ".tsv" ? "tsv" : extension === ".csv" ? "csv" : "xlsx",
    limited: sheets.some((sheet) => sheet.truncated),
    sheets,
  };
}

function parseSheet(sheet: XLSX.WorkSheet, name: string, index: number): SpreadsheetSheet {
  const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  const sourceRows = Math.max(1, range.e.r - range.s.r + 1);
  const sourceColumns = Math.max(1, range.e.c - range.s.c + 1);
  const rowCount = Math.min(sourceRows, MAX_ROWS);
  const columnCount = Math.min(sourceColumns, MAX_COLUMNS);
  const cells: SpreadsheetSheet["cells"] = [];
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      const address = XLSX.utils.encode_cell({ r: range.s.r + row, c: range.s.c + column });
      const cell = sheet[address];
      if (!cell) continue;
      const value = displayValue(cell);
      if (value === null && !cell.f) continue;
      cells.push({ row, column, value, ...(typeof cell.f === "string" ? { formula: cell.f } : {}) });
    }
  }
  const mergedRanges = Array.isArray(sheet["!merges"])
    ? sheet["!merges"].slice(0, 200).map((merge) => ({
      startRow: Math.max(0, merge.s.r - range.s.r),
      startColumn: Math.max(0, merge.s.c - range.s.c),
      endRow: Math.min(rowCount - 1, merge.e.r - range.s.r),
      endColumn: Math.min(columnCount - 1, merge.e.c - range.s.c),
    }))
    : [];
  return {
    name,
    index,
    rowCount,
    columnCount,
    truncated: sourceRows > MAX_ROWS || sourceColumns > MAX_COLUMNS,
    cells,
    mergedRanges,
  };
}

function displayValue(cell: XLSX.CellObject): string | number | boolean | null {
  if (cell.w !== undefined && cell.w !== null) return String(cell.w);
  const value = cell.v;
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

export function parsePresentation(bytes: Buffer): PresentationModel {
  if (bytes.length > 50_000_000) throw new Error("Presentation exceeds the 50 MB preview limit.");
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes);
  } catch {
    throw new Error("Malformed PPTX archive.");
  }
  const presentation = parseXml(archive["ppt/presentation.xml"], "presentation.xml");
  const slideSize = presentation?.["p:presentation"]?.["p:sldSz"] as XmlNode | undefined;
  const width = emu(slideSize?.["@cx"], 10_000);
  const height = emu(slideSize?.["@cy"], 5_625);
  const presentationRels = relationships(archive["ppt/_rels/presentation.xml.rels"]);
  const slideList = ((presentation?.["p:presentation"] as XmlNode | undefined)?.["p:sldIdLst"] as XmlNode | undefined);
  const slideIds = asArray(slideList?.["p:sldId"]);
  const slides: PresentationSlide[] = [];
  for (const [index, slideId] of slideIds.slice(0, MAX_SLIDES).entries()) {
    const relationshipId = stringValue((slideId as XmlNode)["@r:id"]);
    const target = presentationRels.get(relationshipId);
    if (!target) continue;
    const slidePath = resolveZipPath("ppt/presentation.xml", target);
    slides.push(parseSlide(archive, slidePath, index, width, height));
  }
  if (slides.length === 0) throw new Error("PPTX contains no readable slides.");
  return { width, height, slides, limited: slides.length >= MAX_SLIDES };
}

function parseSlide(
  archive: Record<string, Uint8Array>,
  slidePath: string,
  index: number,
  width: number,
  height: number,
): PresentationSlide {
  const document = parseXml(archive[slidePath], slidePath);
  const relationshipsPath = `${slidePath.slice(0, slidePath.lastIndexOf("/"))}/_rels/${slidePath.slice(slidePath.lastIndexOf("/") + 1)}.rels`;
  const rels = relationships(archive[relationshipsPath]);
  const root = (document?.["p:sld"] as XmlNode | undefined)?.["p:cSld"] as XmlNode | undefined;
  const tree = root?.["p:spTree"] as XmlNode | undefined;
  const rawShapes = [
    ...asArray(tree?.["p:sp"]),
    ...asArray(tree?.["p:pic"]),
    ...asArray(tree?.["p:graphicFrame"]),
  ];
  const elements = rawShapes.slice(0, MAX_ELEMENTS_PER_SLIDE).map((shape) => parseSlideElement(shape as XmlNode, slidePath, rels, archive, width, height));
  if (rawShapes.length > MAX_ELEMENTS_PER_SLIDE) {
    elements.push({ kind: "unsupported", x: 0, y: 0, width, height: 22, label: "Additional slide elements were omitted." });
  }
  return { index, elements };
}

function parseSlideElement(
  shape: XmlNode,
  slidePath: string,
  rels: Map<string, string>,
  archive: Record<string, Uint8Array>,
  slideWidth: number,
  slideHeight: number,
): PresentationSlide["elements"][number] {
  const transform = ((shape["p:spPr"] ?? shape["p:pic"]?.["p:spPr"] ?? shape["p:xfrm"]) as XmlNode | undefined)?.["a:xfrm"] as XmlNode | undefined;
  const offset = transform?.["a:off"] as XmlNode | undefined;
  const extent = transform?.["a:ext"] as XmlNode | undefined;
  const x = clamp(emu(offset?.["@x"]), 0, slideWidth);
  const y = clamp(emu(offset?.["@y"]), 0, slideHeight);
  const width = clamp(emu(extent?.["@cx"], 120), 1, slideWidth);
  const height = clamp(emu(extent?.["@cy"], 60), 1, slideHeight);
  const text = textFromShape(shape);
  const imageId = stringValue(((shape["p:blipFill"] as XmlNode | undefined)?.["a:blip"] as XmlNode | undefined)?.["@r:embed"]);
  if (imageId) {
    const target = rels.get(imageId);
    const imagePath = target ? resolveZipPath(slidePath, target) : "";
    const image = imagePath ? archive[imagePath] : undefined;
    if (image && image.byteLength <= MAX_IMAGE_BYTES) {
      const mimeType = mimeForImage(imagePath);
      return { kind: "image", x, y, width, height, imageDataUrl: `data:${mimeType};base64,${Buffer.from(image).toString("base64")}` };
    }
    return { kind: "unsupported", x, y, width, height, label: "Image is too large or unavailable." };
  }
  if (text) return { kind: "text", x, y, width, height, text, fillColor: shapeColor(shape) };
  if (shape["p:spPr"] || shape["p:graphicFrame"]) return { kind: "shape", x, y, width, height, fillColor: shapeColor(shape) };
  return { kind: "unsupported", x, y, width, height, label: "Unsupported PowerPoint element." };
}

function parseXml(bytes: Uint8Array | undefined, name: string): XmlNode {
  if (!bytes) throw new Error(`PPTX is missing ${name}.`);
  try {
    return xmlParser.parse(Buffer.from(bytes).toString("utf8")) as XmlNode;
  } catch {
    throw new Error(`Malformed PPTX XML: ${name}.`);
  }
}

function relationships(bytes: Uint8Array | undefined): Map<string, string> {
  if (!bytes) return new Map();
  const document = parseXml(bytes, "relationships");
  const raw = asArray((document.Relationships as XmlNode | undefined)?.Relationship);
  return new Map(raw.map((relationship) => [
    stringValue((relationship as XmlNode)["@Id"]),
    stringValue((relationship as XmlNode)["@Target"]),
  ]));
}

function textFromShape(shape: XmlNode): string {
  const body = shape["p:txBody"] as XmlNode | undefined;
  const paragraphs = asArray(body?.["a:p"]);
  return paragraphs.map((paragraph) => collectText(paragraph as XmlNode)).filter(Boolean).join("\n");
}

function collectText(node: XmlNode): string {
  const text = node["a:t"];
  if (typeof text === "string") return text;
  if (text && typeof text === "object") return stringValue((text as XmlNode)["#text"]);
  return ["a:r", "a:fld", "a:endParaRPr"].flatMap((key) => asArray(node[key]).map((item) => collectText(item as XmlNode))).join("");
}

function shapeColor(shape: XmlNode): string | undefined {
  const fill = ((shape["p:spPr"] as XmlNode | undefined)?.["a:solidFill"] as XmlNode | undefined)?.["a:srgbClr"] as XmlNode | undefined;
  const color = stringValue(fill?.["@val"]);
  return color ? `#${color}` : undefined;
}

function resolveZipPath(source: string, target: string): string {
  const parts = `${source.slice(0, source.lastIndexOf("/") + 1)}${target}`.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}

function mimeForImage(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function emu(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed / 9525) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
