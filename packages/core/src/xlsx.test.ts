import { describe, it, expect } from "vitest";
import { buildXlsxBytes, colLetter, sanitizeSheetName } from "./xlsx";

/** Read a little-endian uint32 at offset. */
function u32(bytes: Uint8Array, off: number): number {
  return (
    (bytes[off] |
      (bytes[off + 1] << 8) |
      (bytes[off + 2] << 16) |
      (bytes[off + 3] << 24)) >>>
    0
  );
}

/** Extract the stored (uncompressed) entries from a store-method zip. */
function readZipEntries(bytes: Uint8Array): Map<string, string> {
  const dec = new TextDecoder();
  const out = new Map<string, string>();
  let i = 0;
  while (i + 4 <= bytes.length && u32(bytes, i) === 0x04034b50) {
    const size = u32(bytes, i + 18);
    const nameLen = bytes[i + 26] | (bytes[i + 27] << 8);
    const extraLen = bytes[i + 28] | (bytes[i + 29] << 8);
    const nameStart = i + 30;
    const name = dec.decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    const data = bytes.subarray(dataStart, dataStart + size);
    out.set(name, dec.decode(data));
    i = dataStart + size;
  }
  return out;
}

describe("colLetter", () => {
  it("maps indices to spreadsheet columns", () => {
    expect(colLetter(0)).toBe("A");
    expect(colLetter(25)).toBe("Z");
    expect(colLetter(26)).toBe("AA");
    expect(colLetter(27)).toBe("AB");
    expect(colLetter(51)).toBe("AZ");
    expect(colLetter(52)).toBe("BA");
  });
});

describe("sanitizeSheetName", () => {
  it("strips forbidden chars and clamps to 31 chars", () => {
    expect(sanitizeSheetName("By Task", "S1")).toBe("By Task");
    expect(sanitizeSheetName("a/b:c*d?", "S1")).toBe("a b c d");
    expect(sanitizeSheetName("", "Fallback")).toBe("Fallback");
    expect(sanitizeSheetName("x".repeat(40), "S1")).toHaveLength(31);
  });
});

describe("buildXlsxBytes", () => {
  const bytes = buildXlsxBytes({
    sheets: [
      {
        name: "First",
        rows: [
          [{ value: "Name", bold: true }, "Count"],
          ["Alice", 3],
        ],
      },
      {
        name: "Second/Bad:Name",
        rows: [[{ value: null, fill: "#4C6EF5" }]],
      },
    ],
  });
  const entries = readZipEntries(bytes);

  it("produces a valid zip container with the expected parts", () => {
    expect([...entries.keys()]).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "_rels/.rels",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/styles.xml",
        "xl/worksheets/sheet1.xml",
        "xl/worksheets/sheet2.xml",
      ]),
    );
  });

  it("ends with the EOCD signature", () => {
    const eocd = u32(bytes, bytes.length - 22);
    expect(eocd).toBe(0x06054b50);
  });

  it("writes string values as inline strings and numbers as <v>", () => {
    const sheet1 = entries.get("xl/worksheets/sheet1.xml")!;
    expect(sheet1).toContain('<t xml:space="preserve">Alice</t>');
    expect(sheet1).toContain("<v>3</v>");
  });

  it("registers a solid fill in styles for colored cells", () => {
    const styles = entries.get("xl/styles.xml")!;
    expect(styles).toContain('patternType="solid"');
    expect(styles).toContain("FF4C6EF5"); // ARGB of #4C6EF5
  });

  it("sanitizes sheet names in the workbook part", () => {
    const wb = entries.get("xl/workbook.xml")!;
    expect(wb).toContain('name="First"');
    expect(wb).toContain('name="Second Bad Name"');
  });

  it("escapes XML-special characters in cell text", () => {
    const b = buildXlsxBytes({
      sheets: [{ name: "S", rows: [["a & b < c"]] }],
    });
    const s = readZipEntries(b).get("xl/worksheets/sheet1.xml")!;
    expect(s).toContain("a &amp; b &lt; c");
  });
});
