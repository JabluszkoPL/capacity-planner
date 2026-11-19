/**
 * Push a Workbook to Google Sheets, browser-only (no backend).
 *
 * Flow: obtain an OAuth access token via Google Identity Services, then call
 * the Sheets API `spreadsheets.create` with the full grid — values, cell
 * colors, bold headers, frozen rows, and column widths — in a single request.
 *
 * The request body is built by the pure `workbookToCreateRequest`, which is
 * unit-tested; the token + fetch plumbing needs a real Google login and the
 * deployer's own OAuth client ID, so it can't be exercised in tests.
 */
import {
  normalizeCell,
  sanitizeSheetName,
  type Workbook,
  type XlsxCell,
} from "@planner/core";

const GIS_SRC = "https://accounts.google.com/gsi/client";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const CREATE_URL = "https://sheets.googleapis.com/v4/spreadsheets";

/** The configured OAuth client ID, or undefined if none was provided. */
export function googleClientId(): string | undefined {
  const id = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  return id && id.trim() ? id.trim() : undefined;
}

export function isGoogleConfigured(): boolean {
  return !!googleClientId();
}

/* --------------------------- request builder ---------------------------- */

interface SheetsColor {
  red: number;
  green: number;
  blue: number;
}

interface SheetsCellFormat {
  backgroundColor?: SheetsColor;
  textFormat?: { bold?: boolean; foregroundColor?: SheetsColor };
  horizontalAlignment?: string;
}

interface SheetsCell {
  userEnteredValue?: { stringValue?: string; numberValue?: number };
  userEnteredFormat?: SheetsCellFormat;
}

interface SheetsGridProperties {
  rowCount: number;
  columnCount: number;
  frozenRowCount?: number;
}

interface SheetsSheet {
  properties: {
    sheetId: number;
    title: string;
    gridProperties: SheetsGridProperties;
  };
  data: {
    startRow: number;
    startColumn: number;
    rowData: { values: SheetsCell[] }[];
    columnMetadata?: { pixelSize: number }[];
  }[];
}

export interface SheetsCreateRequest {
  properties: { title: string };
  sheets: SheetsSheet[];
}

/** Parse "RRGGBB" / "#RRGGBB" into a Sheets API 0..1 RGB color. */
export function hexToRgb(hex: string): SheetsColor {
  const h = hex.replace(/^#/, "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return { red: r / 255, green: g / 255, blue: b / 255 };
}

function cellData(cell: XlsxCell): SheetsCell {
  const data: SheetsCell = {};

  if (typeof cell.value === "number") {
    data.userEnteredValue = { numberValue: cell.value };
  } else if (typeof cell.value === "string" && cell.value !== "") {
    data.userEnteredValue = { stringValue: cell.value };
  }

  const format: SheetsCellFormat = {};
  if (cell.fill) format.backgroundColor = hexToRgb(cell.fill);
  const textFormat: { bold?: boolean; foregroundColor?: SheetsColor } = {};
  if (cell.bold) textFormat.bold = true;
  if (cell.color) textFormat.foregroundColor = hexToRgb(cell.color);
  if (Object.keys(textFormat).length) format.textFormat = textFormat;
  if (cell.align) format.horizontalAlignment = cell.align.toUpperCase();
  if (Object.keys(format).length) data.userEnteredFormat = format;

  return data;
}

/** Excel "character" column width → an approximate pixel width for Sheets. */
function widthToPixels(width: number): number {
  return Math.max(Math.round(width * 7) + 5, 8);
}

/**
 * Build the `spreadsheets.create` request body for a workbook. Pure and
 * deterministic — the tested core of the integration.
 */
export function workbookToCreateRequest(
  wb: Workbook,
  title: string,
): SheetsCreateRequest {
  const sheets: SheetsSheet[] = wb.sheets.map((sheet, index) => {
    const rowData = sheet.rows.map((row) => ({
      values: row.map((input) => cellData(normalizeCell(input))),
    }));

    const columnMetadata = sheet.columns?.map((c) => ({
      pixelSize: widthToPixels(c.width),
    }));

    const gridProperties: SheetsGridProperties = {
      rowCount: Math.max(sheet.rows.length, 1),
      columnCount: Math.max(
        sheet.columns?.length ?? 0,
        ...sheet.rows.map((r) => r.length),
        1,
      ),
    };
    if (sheet.freezeHeader) gridProperties.frozenRowCount = 1;

    return {
      properties: {
        sheetId: index,
        title: sanitizeSheetName(sheet.name, `Sheet${index + 1}`),
        gridProperties,
      },
      data: [
        {
          startRow: 0,
          startColumn: 0,
          rowData,
          ...(columnMetadata ? { columnMetadata } : {}),
        },
      ],
    };
  });

  return { properties: { title }, sheets };
}

/* ------------------------------ OAuth token ----------------------------- */

let gisPromise: Promise<void> | null = null;

/** Load the Google Identity Services script exactly once. */
function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gisPromise = null;
      reject(new Error("Couldn't load Google sign-in."));
    };
    document.head.appendChild(script);
  });
  return gisPromise;
}

/**
 * Request an OAuth access token for the Sheets/Drive scope. Opens Google's
 * consent popup on first use. Rejects if the user cancels or sign-in fails.
 */
export async function requestAccessToken(clientId: string): Promise<string> {
  await loadGis();
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) throw new Error("Google sign-in is unavailable.");

  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.access_token) resolve(resp.access_token);
        else
          reject(new Error(resp.error_description || "Sign-in was cancelled."));
      },
      error_callback: (err) =>
        reject(new Error(err.message || "Sign-in was cancelled.")),
    });
    client.requestAccessToken();
  });
}

/* ------------------------------- push ----------------------------------- */

export interface PushResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
}

/** Create a new Google spreadsheet from a workbook. Requires a valid token. */
export async function createSpreadsheet(
  wb: Workbook,
  title: string,
  token: string,
): Promise<PushResult> {
  const body = workbookToCreateRequest(wb, title);
  const res = await fetch(CREATE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const err = await res.json();
      detail = err?.error?.message ? ` (${err.error.message})` : "";
    } catch {
      /* ignore */
    }
    throw new Error(`Google Sheets rejected the request${detail}.`);
  }
  const json = await res.json();
  return {
    spreadsheetId: json.spreadsheetId,
    spreadsheetUrl:
      json.spreadsheetUrl ||
      `https://docs.google.com/spreadsheets/d/${json.spreadsheetId}/edit`,
  };
}

/**
 * End-to-end: sign in (if needed) and create the spreadsheet. Throws with a
 * user-facing message when the client ID isn't configured.
 */
export async function pushWorkbookToGoogleSheets(
  wb: Workbook,
  title: string,
): Promise<PushResult> {
  const clientId = googleClientId();
  if (!clientId) {
    throw new Error(
      "Google Sheets isn't configured — set VITE_GOOGLE_CLIENT_ID (see docs/GOOGLE_SHEETS.md).",
    );
  }
  const token = await requestAccessToken(clientId);
  return createSpreadsheet(wb, title, token);
}
