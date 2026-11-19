import { describe, it, expect } from "vitest";
import { hexToRgb, workbookToCreateRequest } from "./googleSheets";
import type { Workbook } from "@planner/core";

describe("hexToRgb", () => {
  it("parses hex (with or without #) into 0..1 channels", () => {
    expect(hexToRgb("#000000")).toEqual({ red: 0, green: 0, blue: 0 });
    expect(hexToRgb("FFFFFF")).toEqual({ red: 1, green: 1, blue: 1 });
    const blue = hexToRgb("#4C6EF5");
    expect(blue.red).toBeCloseTo(0x4c / 255);
    expect(blue.green).toBeCloseTo(0x6e / 255);
    expect(blue.blue).toBeCloseTo(0xf5 / 255);
  });
});

describe("workbookToCreateRequest", () => {
  const wb: Workbook = {
    sheets: [
      {
        name: "Assignments",
        freezeHeader: true,
        columns: [{ width: 34 }, { width: 7 }],
        rows: [
          [
            { value: "Task", bold: true, fill: "1E293B", color: "FFFFFF" },
            "Days",
          ],
          ["Build API", 3],
        ],
      },
      {
        name: "By Person/x",
        columns: [{ width: 30 }, { width: 3 }],
        rows: [["Person", { value: null, fill: "4C6EF5" }]],
      },
    ],
  };

  const req = workbookToCreateRequest(wb, "My Plan");

  it("sets the spreadsheet title", () => {
    expect(req.properties.title).toBe("My Plan");
  });

  it("creates one sheet per workbook sheet with sanitized titles", () => {
    expect(req.sheets).toHaveLength(2);
    expect(req.sheets[0].properties.title).toBe("Assignments");
    expect(req.sheets[1].properties.title).toBe("By Person x"); // '/' stripped
  });

  it("freezes the header row only where requested", () => {
    expect(req.sheets[0].properties.gridProperties.frozenRowCount).toBe(1);
    expect(
      req.sheets[1].properties.gridProperties.frozenRowCount,
    ).toBeUndefined();
  });

  it("emits number vs string values correctly", () => {
    const rows = req.sheets[0].data[0].rowData;
    expect(rows[1].values[0].userEnteredValue).toEqual({
      stringValue: "Build API",
    });
    expect(rows[1].values[1].userEnteredValue).toEqual({ numberValue: 3 });
  });

  it("maps bold + fill + font color into userEnteredFormat", () => {
    const fmt = req.sheets[0].data[0].rowData[0].values[0].userEnteredFormat!;
    expect(fmt.textFormat!.bold).toBe(true);
    expect(fmt.backgroundColor!.red).toBeCloseTo(0x1e / 255);
    expect(fmt.textFormat!.foregroundColor).toEqual({
      red: 1,
      green: 1,
      blue: 1,
    });
  });

  it("keeps an empty colored cell as a background-only cell (no value)", () => {
    const cell = req.sheets[1].data[0].rowData[0].values[1];
    expect(cell.userEnteredValue).toBeUndefined();
    expect(cell.userEnteredFormat!.backgroundColor!.blue).toBeCloseTo(
      0xf5 / 255,
    );
  });

  it("includes column widths as pixel sizes", () => {
    const meta = req.sheets[0].data[0].columnMetadata!;
    expect(meta).toHaveLength(2);
    expect(meta[0].pixelSize).toBeGreaterThan(meta[1].pixelSize);
  });
});
