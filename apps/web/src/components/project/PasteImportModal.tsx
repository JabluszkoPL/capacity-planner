import { useMemo, useState } from "react";
import { type Project, parseImport, colorFor, NEW_EPIC } from "@planner/core";
import { useAppStore } from "@planner/client-runtime";
import { useToast } from "../ui/Toast";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { ColorTag } from "../ui/Badge";

/** At most this many parsed rows are previewed; the import takes them all. */
const PREVIEW_ROWS = 50;

interface PasteImportModalProps {
  open: boolean;
  onClose: () => void;
  project: Project;
}

export function PasteImportModal({
  open,
  onClose,
  project,
}: PasteImportModalProps) {
  const { actions } = useAppStore();
  const toast = useToast();
  const [text, setText] = useState("");
  const [target, setTarget] = useState(NEW_EPIC);

  // A live, read-only preview of what Import will create. The same parser
  // runs again on Import, so the preview can never disagree with the result.
  const preview = useMemo(() => {
    if (!text.trim()) return null;
    const result = parseImport(
      text,
      project.epics.map((e) => ({ id: e.id, name: e.name })),
      target,
    );
    const rows = result.groups.flatMap((g) => {
      const epic =
        g.newEpicName ??
        project.epics.find((e) => e.id === g.existingEpicId)?.name ??
        "";
      return g.tasks.map((t) => ({ epic, isNew: !!g.newEpicName, task: t }));
    });
    return { count: result.importedCount, rows };
  }, [text, target, project.epics]);

  const close = () => {
    setText("");
    setTarget(NEW_EPIC);
    onClose();
  };

  const handleImport = () => {
    const result = parseImport(
      text,
      project.epics.map((e) => ({ id: e.id, name: e.name })),
      target,
    );

    if (result.importedCount === 0) {
      toast("No rows recognized — check the format and try again.");
      return;
    }

    const norm = (s: string) => s.trim().toLowerCase();

    // Name → id maps, seeded with what already exists in the project so
    // dependencies can point at pre-existing tasks/epics too. Newly imported
    // entities are added below and take precedence on name clashes.
    const epicIdByName = new Map<string, string>();
    const taskIdByName = new Map<string, string>();
    for (const e of project.epics) {
      epicIdByName.set(norm(e.name), e.id);
      for (const t of e.tasks) taskIdByName.set(norm(t.name), t.id);
    }

    // Per-epic records so we can apply dependencies after every id exists.
    interface EpicRecord {
      epicId: string;
      epicDependsOn: string[];
      currentDeps: string[];
    }
    interface TaskRecord {
      epicId: string;
      taskId: string;
      dependsOn: string[];
    }
    const epicRecords: EpicRecord[] = [];
    const taskRecords: TaskRecord[] = [];

    // Pass 1 — create epics and tasks, collecting ids by name.
    for (const group of result.groups) {
      const epicId =
        group.existingEpicId ??
        (group.newEpicName
          ? actions.addEpic(project.id, group.newEpicName)
          : null);
      if (!epicId) continue;
      if (group.newEpicName) epicIdByName.set(norm(group.newEpicName), epicId);

      const existingEpic = project.epics.find((e) => e.id === epicId);
      epicRecords.push({
        epicId,
        epicDependsOn: group.epicDependsOn,
        currentDeps: existingEpic?.dependsOn ?? [],
      });

      for (const t of group.tasks) {
        const taskId = actions.addTask(project.id, epicId, {
          name: t.name,
          estimateDays: t.estimateDays,
          specialization: t.specialization,
          excluded: false,
        });
        taskIdByName.set(norm(t.name), taskId);
        taskRecords.push({ epicId, taskId, dependsOn: t.dependsOn });
      }
    }

    // Pass 2 — resolve dependency names to ids now that everything exists.
    let unresolved = 0;

    for (const rec of taskRecords) {
      if (rec.dependsOn.length === 0) continue;
      const ids: string[] = [];
      for (const name of rec.dependsOn) {
        const depId = taskIdByName.get(norm(name));
        if (depId && depId !== rec.taskId) {
          if (!ids.includes(depId)) ids.push(depId);
        } else if (!depId) {
          unresolved++;
        }
      }
      if (ids.length > 0) {
        actions.editTask(project.id, rec.epicId, rec.taskId, {
          dependsOn: ids,
        });
      }
    }

    for (const rec of epicRecords) {
      const current = new Set(rec.currentDeps);
      for (const name of rec.epicDependsOn) {
        const depId = epicIdByName.get(norm(name));
        if (depId && depId !== rec.epicId && !current.has(depId)) {
          actions.toggleEpicDependency(project.id, rec.epicId, depId);
          current.add(depId);
        } else if (!depId) {
          unresolved++;
        }
      }
    }

    const n = result.importedCount;
    let message = `Imported ${n} task${n === 1 ? "" : "s"}.`;
    if (unresolved > 0) {
      message += ` ${unresolved} dependenc${
        unresolved === 1 ? "y" : "ies"
      } couldn't be matched by name.`;
    }
    toast(message);
    close();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Paste from Google Sheets"
      subtitle="Bring epics and tasks in from a spreadsheet."
      className="import-modal"
    >
      <p className="modal-hint">
        Paste rows copied from a spreadsheet. Columns are tab-separated (comma
        also works). Two shapes are supported:
      </p>
      <ul className="modal-hint-list">
        <li>
          <strong>4 columns:</strong> Epic, Task, Estimate, Specialization. The
          epic is created if it doesn't exist yet.
        </li>
        <li>
          <strong>3 columns:</strong> Task, Estimate, Specialization, added to
          the epic selected below.
        </li>
        <li>
          <strong>Optional 5th/6th columns:</strong> task dependencies and epic
          dependencies. Reference other tasks/epics by name, separating several
          with <code>;</code> or <code>|</code>. Names are matched
          case-insensitively; unmatched ones are reported and skipped.
        </li>
      </ul>

      <label className="modal-field-label" htmlFor="import-target">
        Target epic for 3-column rows
      </label>
      <select
        id="import-target"
        className="import-target"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
      >
        <option value={NEW_EPIC}>New "Imported" epic</option>
        {project.epics.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>

      <label className="modal-field-label" htmlFor="import-text">
        Pasted rows
      </label>
      <textarea
        id="import-text"
        aria-label="Pasted rows"
        value={text}
        placeholder={
          "Onboarding\tDesign screens\t3\tDesign\nOnboarding\tBuild UI\t5\tFrontend\tDesign screens"
        }
        onChange={(e) => setText(e.target.value)}
      />

      {preview && (
        <div className="import-preview">
          {preview.count > 0 ? (
            <>
              <div className="modal-field-label">
                Parsed preview ({preview.count} row
                {preview.count === 1 ? "" : "s"})
              </div>
              <div className="import-preview-table">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Epic</th>
                      <th>Task</th>
                      <th className="num">Days</th>
                      <th>Specialization</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                      <tr key={i}>
                        <td>
                          {r.epic}
                          {r.isNew && <span className="import-new"> new</span>}
                        </td>
                        <td>{r.task.name}</td>
                        <td className="num">{r.task.estimateDays}</td>
                        <td>
                          {r.task.specialization && (
                            <ColorTag color={colorFor(r.task.specialization)}>
                              {r.task.specialization}
                            </ColorTag>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Callout tone="success" role="status">
                {preview.count} row{preview.count === 1 ? "" : "s"} ready to
                import.
                {preview.rows.length > PREVIEW_ROWS &&
                  ` Showing the first ${PREVIEW_ROWS}.`}
              </Callout>
            </>
          ) : (
            <Callout tone="warning" role="status">
              Nothing to import yet. Check the columns match one of the shapes
              above.
            </Callout>
          )}
        </div>
      )}

      <div className="modal-actions">
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={handleImport}>
          Import
        </Button>
      </div>
    </Modal>
  );
}
