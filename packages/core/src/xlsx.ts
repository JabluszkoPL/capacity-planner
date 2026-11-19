/**
 * Minimal, dependency-free `.xlsx` (Office Open XML) writer.
 *
 * Supports what the Planner export needs and no more: multiple sheets, inline
 * string + number cells, per-column widths, bold/colored fonts, solid cell
 * fills, and a frozen header row. Files are packaged with an inline ZIP writer
 * (store method, no compression) so there are zero runtime dependencies.
 */

export interface XlsxCell {
  value: string | number | null;
  bold?: boolean;
  /** Solid fill color, "RRGGBB" or "#RRGGBB". */
  fill?: string;
  /** Font color, "RRGGBB" or "#RRGGBB". */
  color?: string;
  align?: "left" | "center" | "right";
}

/** A cell may be given fully, or as a bare string/number/null shorthand. */
export type XlsxCellInput = XlsxCell | string | number | null;

export interface XlsxSheet {
  name: string;
  /** Column widths in Excel "characters"; index-aligned to columns. */
  columns?: { width: number }[];
  rows: XlsxCellInput[][];
  /** Freeze the first row as a header. */
  freezeHeader?: boolean;
}

export interface Workbook {
  sheets: XlsxSheet[];
}

/* --------------------------------- XML ---------------------------------- */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normColor(c: string): string {
  const hex = c.replace(/^#/, "").toUpperCase();
  return "FF" + hex; // ARGB
}

/** Normalize the string/number/null shorthand into a full cell object. */
export function normalizeCell(input: XlsxCellInput): XlsxCell {
  if (input === null) return { value: null };
  if (typeof input === "string" || typeof input === "number") {
    return { value: input };
  }
  return input;
}

/** Column index (0-based) → spreadsheet letter (A, B, …, Z, AA, …). */
export function colLetter(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/* ------------------------------- styles --------------------------------- */

interface StyleKey {
  bold: boolean;
  fill: string | null;
  color: string | null;
  align: XlsxCell["align"];
}

class StyleTable {
  private map = new Map<string, number>();
  private keys: StyleKey[] = [];

  constructor() {
    // Index 0 is the default (no styling).
    this.map.set("|||", 0);
    this.keys.push({ bold: false, fill: null, color: null, align: undefined });
  }

  idFor(cell: XlsxCell): number {
    const key: StyleKey = {
      bold: !!cell.bold,
      fill: cell.fill ? normColor(cell.fill) : null,
      color: cell.color ? normColor(cell.color) : null,
      align: cell.align,
    };
    const k = `${key.bold ? "b" : ""}|${key.fill ?? ""}|${key.color ?? ""}|${key.align ?? ""}`;
    let id = this.map.get(k);
    if (id === undefined) {
      id = this.keys.length;
      this.map.set(k, id);
      this.keys.push(key);
    }
    return id;
  }

  toXml(): string {
    // Fonts: index 0 is the base font. Each (bold, color) combo gets its own.
    const fonts: string[] = [
      '<font><sz val="11"/><name val="Calibri"/></font>',
    ];
    const fontIndex = new Map<string, number>();
    fontIndex.set("|", 0);
    // Fills: 0 = none, 1 = gray125 (both reserved by the spec).
    const fills: string[] = [
      '<fill><patternFill patternType="none"/></fill>',
      '<fill><patternFill patternType="gray125"/></fill>',
    ];
    const fillIndex = new Map<string, number>();

    const xfs: string[] = [
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    ];

    for (let i = 1; i < this.keys.length; i++) {
      const key = this.keys[i];

      const fontKey = `${key.bold ? "b" : ""}|${key.color ?? ""}`;
      let fontId = fontIndex.get(fontKey);
      if (fontId === undefined) {
        const parts = ['<sz val="11"/>', '<name val="Calibri"/>'];
        if (key.bold) parts.unshift("<b/>");
        if (key.color) parts.push(`<color rgb="${key.color}"/>`);
        fontId = fonts.length;
        fonts.push(`<font>${parts.join("")}</font>`);
        fontIndex.set(fontKey, fontId);
      }

      let fillId = 0;
      if (key.fill) {
        fillId = fillIndex.get(key.fill) ?? -1;
        if (fillId === -1) {
          fillId = fills.length;
          fills.push(
            `<fill><patternFill patternType="solid"><fgColor rgb="${key.fill}"/><bgColor indexed="64"/></patternFill></fill>`,
          );
          fillIndex.set(key.fill, fillId);
        }
      }

      const attrs =
        `numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0"` +
        (fontId !== 0 ? ' applyFont="1"' : "") +
        (fillId !== 0 ? ' applyFill="1"' : "") +
        (key.align ? ' applyAlignment="1"' : "");
      if (key.align) {
        xfs.push(`<xf ${attrs}><alignment horizontal="${key.align}"/></xf>`);
      } else {
        xfs.push(`<xf ${attrs}/>`);
      }
    }

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="${fonts.length}">${fonts.join("")}</fonts>
<fills count="${fills.length}">${fills.join("")}</fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  }
}

/* ----------------------------- worksheet -------------------------------- */

function sheetXml(sheet: XlsxSheet, styles: StyleTable): string {
  const rowsXml = sheet.rows
    .map((row, r) => {
      const cellsXml = row
        .map((input, c) => {
          const cell = normalizeCell(input);
          const ref = colLetter(c) + (r + 1);
          const s = styles.idFor(cell);
          const sAttr = s !== 0 ? ` s="${s}"` : "";
          if (cell.value === null || cell.value === "") {
            return `<c r="${ref}"${sAttr}/>`;
          }
          if (typeof cell.value === "number") {
            return `<c r="${ref}"${sAttr}><v>${cell.value}</v></c>`;
          }
          return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(String(cell.value))}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cellsXml}</row>`;
    })
    .join("");

  const cols = sheet.columns?.length
    ? `<cols>${sheet.columns
        .map(
          (col, i) =>
            `<col min="${i + 1}" max="${i + 1}" width="${col.width}" customWidth="1"/>`,
        )
        .join("")}</cols>`
    : "";

  const views = sheet.freezeHeader
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>'
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${views}${cols}<sheetData>${rowsXml}</sheetData></worksheet>`;
}

/** Excel forbids these in sheet names, and names must be ≤ 31 chars. */
export function sanitizeSheetName(name: string, fallback: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, " ").trim();
  return (cleaned || fallback).slice(0, 31);
}

/* -------------------------------- ZIP ----------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function zipStore(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const DOS_DATE = 0x21; // 1980-01-01, fixed for reproducibility
  const FLAGS = 0x0800; // bit 11: filename is UTF-8

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, FLAGS, true);
    lh.setUint16(8, 0, true); // store
    lh.setUint16(10, 0, true); // time
    lh.setUint16(12, DOS_DATE, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    const localHeader = new Uint8Array(lh.buffer);
    chunks.push(localHeader, nameBytes, e.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, FLAGS, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, DOS_DATE, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true);
    cd.setUint16(32, 0, true);
    cd.setUint16(34, 0, true);
    cd.setUint16(36, 0, true);
    cd.setUint32(38, 0, true);
    cd.setUint32(42, offset, true);
    central.push(concatBytes([new Uint8Array(cd.buffer), nameBytes]));

    offset += localHeader.length + nameBytes.length + size;
  }

  const centralData = concatBytes(central);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralData.length, true);
  eocd.setUint32(16, offset, true);
  eocd.setUint16(20, 0, true);

  return concatBytes([...chunks, centralData, new Uint8Array(eocd.buffer)]);
}

/* ------------------------------- package -------------------------------- */

function buildParts(wb: Workbook): ZipEntry[] {
  const enc = new TextEncoder();
  const styles = new StyleTable();

  // Rendering sheets populates the style table, so do it before styles.xml.
  const sheetXmls = wb.sheets.map((s) => sheetXml(s, styles));

  const sheetsMeta = wb.sheets.map((s, i) => ({
    name: sanitizeSheetName(s.name, `Sheet${i + 1}`),
    id: i + 1,
    rid: `rId${i + 1}`,
    file: `sheet${i + 1}.xml`,
  }));
  const stylesRid = `rId${wb.sheets.length + 1}`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheetsMeta
  .map(
    (m) =>
      `<Override PartName="/xl/worksheets/${m.file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  )
  .join("\n")}
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetsMeta
    .map(
      (m) => `<sheet name="${esc(m.name)}" sheetId="${m.id}" r:id="${m.rid}"/>`,
    )
    .join("")}</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetsMeta
  .map(
    (m) =>
      `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${m.file}"/>`,
  )
  .join("\n")}
<Relationship Id="${stylesRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "xl/workbook.xml", data: enc.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(workbookRels) },
    { name: "xl/styles.xml", data: enc.encode(styles.toXml()) },
  ];
  sheetsMeta.forEach((m, i) => {
    entries.push({
      name: `xl/worksheets/${m.file}`,
      data: enc.encode(sheetXmls[i]),
    });
  });
  return entries;
}

/** Serialize a workbook to raw `.xlsx` bytes. */
export function buildXlsxBytes(wb: Workbook): Uint8Array {
  return zipStore(buildParts(wb));
}
