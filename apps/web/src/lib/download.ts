/**
 * Browser download helpers.
 *
 * The workbook and JSON builders themselves are pure and live in
 * @planner/core, where the server and (later) React Native can use them too.
 * Only the last step — handing bytes to the browser — is here, because it is
 * the only part that needs a Blob and a document.
 */
import {
  buildPlanWorkbook,
  buildXlsxBytes,
  planFilenameStem,
  serializeState,
  parseImportedState,
  type AppState,
  type Project,
  type TeamMember,
  type Workbook,
} from "@planner/core";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function buildXlsxBlob(wb: Workbook): Blob {
  return new Blob([buildXlsxBytes(wb) as BlobPart], { type: XLSX_MIME });
}

/** Save a blob under `filename`, cleaning up the object URL afterwards. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadPlanExcel(
  project: Project,
  team: { members: TeamMember[]; offDays: Record<string, string[]> },
  filename = `${planFilenameStem(project)}.xlsx`,
): void {
  downloadBlob(buildXlsxBlob(buildPlanWorkbook(project, team)), filename);
}

export function downloadStateJson(state: AppState, filename: string): void {
  downloadBlob(
    new Blob([serializeState(state)], { type: "application/json" }),
    filename,
  );
}

/** Read a file chosen from an `<input type="file">` as text. */
export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsText(file);
  });
}

/** Read + parse a file chosen from an `<input type="file">`. */
export async function readStateFile(file: File): Promise<AppState> {
  return parseImportedState(await readTextFile(file));
}
