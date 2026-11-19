import { useRef, useState } from "react";
import { useAppStore } from "@planner/client-runtime";
import { mergeImportedState } from "@planner/core";
import { readStateFile } from "../../lib/download";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";

/**
 * Import a Planner JSON export — including one from the old browser-only
 * Planner, whose shared types are identical to ours. Its "Export everything"
 * writes a full backup, which is how data moves across: the two apps run on
 * different ports, so the automatic first-run pickup in `legacyImport.ts`
 * never sees the old localStorage.
 *
 * The incoming state is *folded into* the current one rather than replacing it
 * (see {@link mergeImportedState}), because the reason to import an old draft
 * is to compare it with the drafts already here. The merged state goes through
 * the ordinary `importState` action, so the store's commit effect diffs it and
 * writes only the new rows — existing projects are never re-written or
 * tombstoned.
 */
export function ImportProjectsButton() {
  const { state, actions } = useAppStore();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const incoming = await readStateFile(file);
      const report = mergeImportedState(state, incoming);

      // A full backup from the old Planner can carry teams no project uses,
      // so a file with new teams but no projects is still worth importing.
      if (report.addedProjects === 0 && report.addedTeams === 0) {
        toast("That file had nothing new to import.");
        return;
      }

      actions.importState(report.state);

      const parts: string[] = [];
      if (report.addedProjects > 0) {
        parts.push(
          report.addedProjects === 1
            ? "1 project"
            : `${report.addedProjects} projects`,
        );
      }
      if (report.addedTeams > 0) {
        parts.push(
          report.addedTeams === 1
            ? "1 new team"
            : `${report.addedTeams} new teams`,
        );
      }
      parts[0] = `Imported ${parts[0]}`;
      if (report.renamedProjects.length > 0) {
        parts.push(`renamed ${report.renamedProjects.join(", ")}`);
      }
      toast(parts.join(" · "));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't import that file.");
    } finally {
      setBusy(false);
      // Clear the input so re-picking the same file fires onChange again.
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />
      <Button onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? "Importing…" : "Import…"}
      </Button>
    </>
  );
}
