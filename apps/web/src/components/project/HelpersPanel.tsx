import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  type Helper,
  type Project,
  colorFor,
  projectSpecializations,
  addDays,
  fromISO,
  toISO,
} from "@planner/core";
import { useAppStore } from "@planner/client-runtime";
import { Button } from "../ui/Button";
import { ComboInput } from "../ui/ComboInput";
import { IconButton } from "../ui/IconButton";
import { EmptyState } from "../ui/EmptyState";
import { Modal } from "../ui/Modal";
import { Panel } from "../ui/Panel";
import { Icon } from "../ui/Icon";
import "./helpers.css";

interface HelpersPanelProps {
  project: Project;
}

export function HelpersPanel({ project }: HelpersPanelProps) {
  const { state, actions } = useAppStore();
  const helpers = project.helpers ?? [];
  const specOptions = useMemo(
    () => projectSpecializations(project, state.teams),
    [project, state.teams],
  );

  return (
    <Panel
      className="helpers-panel"
      title="Project helpers"
      subtitle="External people lending a hand on this project only. Speed scales the estimate (0.6 means a 5-day task takes about 9 workdays), and a helper is only scheduled within their availability dates and outside their days off."
    >
      {helpers.length === 0 ? (
        <EmptyState
          compact
          title="No helpers"
          message="Add an external helper below to include them in the plan."
        />
      ) : (
        <div className="helper-list">
          <div className="helper-row helper-head">
            <span>Name</span>
            <span>Specialization</span>
            <span>Speed</span>
            <span>Available from</span>
            <span>Available to</span>
            <span>Days off</span>
            <span />
          </div>
          {helpers.map((h) => (
            <HelperRow
              key={h.id}
              projectId={project.id}
              helper={h}
              specOptions={specOptions}
            />
          ))}
        </div>
      )}

      <AddHelperForm
        onAdd={(helper) => actions.addHelper(project.id, helper)}
        specOptions={specOptions}
        defaultFrom={project.startDate}
      />
    </Panel>
  );
}

function blurOnEnter(e: KeyboardEvent<HTMLInputElement>) {
  if (e.key === "Enter") {
    e.preventDefault();
    e.currentTarget.blur();
  }
}

function HelperRow({
  projectId,
  helper,
  specOptions,
}: {
  projectId: string;
  helper: Helper;
  specOptions: string[];
}) {
  const { actions } = useAppStore();
  const [name, setName] = useState(helper.name);
  const [spec, setSpec] = useState(helper.specialization);

  const commitName = () => {
    const next = name.trim();
    if (!next) {
      setName(helper.name);
      return;
    }
    if (next !== helper.name)
      actions.editHelper(projectId, helper.id, { name: next });
  };
  const commitSpec = (value: string) => {
    const next = value.trim();
    if (next !== helper.specialization)
      actions.editHelper(projectId, helper.id, { specialization: next });
  };

  return (
    <div className="helper-row">
      <span className="helper-name-cell">
        <span
          className="swatch"
          style={{ background: colorFor(helper.specialization) }}
          aria-hidden="true"
        />
        <input
          type="text"
          className="helper-name-input"
          aria-label="Helper name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={blurOnEnter}
        />
      </span>
      <ComboInput
        aria-label="Helper specialization"
        placeholder="e.g. Backend"
        value={spec}
        options={specOptions}
        onChange={setSpec}
        onCommit={commitSpec}
      />
      <input
        type="number"
        className="helper-speed"
        aria-label="Helper speed"
        min="0.1"
        step="0.1"
        value={helper.speed}
        onChange={(e) => {
          const v = Number(e.target.value);
          actions.editHelper(projectId, helper.id, {
            speed: Number.isFinite(v) && v > 0 ? v : 1,
          });
        }}
      />
      <input
        type="date"
        aria-label="Available from"
        value={helper.availableFrom}
        onChange={(e) =>
          actions.editHelper(projectId, helper.id, {
            availableFrom: e.target.value,
          })
        }
      />
      <input
        type="date"
        aria-label="Available to"
        value={helper.availableTo}
        onChange={(e) =>
          actions.editHelper(projectId, helper.id, {
            availableTo: e.target.value,
          })
        }
      />
      <HelperOffDays projectId={projectId} helper={helper} />
      <IconButton
        danger
        label={`Remove ${helper.name}`}
        onClick={() => actions.deleteHelper(projectId, helper.id)}
      >
        <Icon name="trash" size={14} />
      </IconButton>
    </div>
  );
}

/** Locale-formatted, sortable label for an off-day chip. */
function offDayLabel(iso: string): string {
  const d = fromISO(iso);
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * The "Days off" cell: a button showing the count, opening a small manager to
 * add individual dates (e.g. Christmas holidays) and remove them again. Off
 * dates are kept sorted so the plan and the chip list stay in date order.
 */
function HelperOffDays({
  projectId,
  helper,
}: {
  projectId: string;
  helper: Helper;
}) {
  const { actions } = useAppStore();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState("");
  const offDays = helper.offDays ?? [];

  const setOffDays = (next: string[]) => {
    // De-dupe + sort so ISO order == calendar order.
    const sorted = [...new Set(next)].sort();
    actions.editHelper(projectId, helper.id, { offDays: sorted });
  };

  const addDay = () => {
    if (!pick || offDays.includes(pick)) {
      setPick("");
      return;
    }
    setOffDays([...offDays, pick]);
    setPick("");
  };

  const removeDay = (iso: string) =>
    setOffDays(offDays.filter((d) => d !== iso));

  return (
    <>
      <button
        type="button"
        className="helper-offdays-btn"
        aria-label={`Days off for ${helper.name}`}
        onClick={() => setOpen(true)}
      >
        <Icon name="calendar" size={13} />
        {offDays.length === 0
          ? "None"
          : `${offDays.length} day${offDays.length === 1 ? "" : "s"}`}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Days off — ${helper.name}`}
      >
        <p className="muted helper-offdays-hint">
          Pick individual days this helper won't work (e.g. Christmas holidays).
          The plan skips them like weekends.
        </p>
        <div className="helper-offdays-add">
          <input
            type="date"
            aria-label="Off day"
            value={pick}
            min={helper.availableFrom}
            max={helper.availableTo}
            onChange={(e) => setPick(e.target.value)}
          />
          <Button
            type="button"
            variant="primary"
            icon="plus"
            onClick={addDay}
            disabled={!pick}
          >
            Add day
          </Button>
        </div>
        {offDays.length === 0 ? (
          <p className="muted">No days off yet.</p>
        ) : (
          <ul className="helper-offdays-list">
            {offDays.map((iso) => (
              <li key={iso}>
                <span>{offDayLabel(iso)}</span>
                <IconButton
                  danger
                  label={`Remove ${offDayLabel(iso)}`}
                  onClick={() => removeDay(iso)}
                >
                  <Icon name="x" size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <div className="helper-offdays-actions">
          <Button type="button" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </Modal>
    </>
  );
}

function AddHelperForm({
  onAdd,
  defaultFrom,
  specOptions,
}: {
  onAdd: (helper: Omit<Helper, "id">) => void;
  defaultFrom: string;
  specOptions: string[];
}) {
  const defaultTo = toISO(addDays(fromISO(defaultFrom), 28));
  const [name, setName] = useState("");
  const [spec, setSpec] = useState("");
  const [speed, setSpeed] = useState("1");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Please enter a name.");
      return;
    }
    const s = Number(speed);
    onAdd({
      name: trimmed,
      specialization: spec.trim(),
      speed: Number.isFinite(s) && s > 0 ? s : 1,
      availableFrom: from,
      availableTo: to,
    });
    setName("");
    setSpec("");
    setSpeed("1");
    setFrom(defaultFrom);
    setTo(defaultTo);
    setError(null);
  };

  return (
    <form
      className="add-helper-form"
      onSubmit={submit}
      aria-labelledby="ah-title"
    >
      <h3 id="ah-title" className="add-helper-title">
        Add a helper
      </h3>
      <div className="field">
        <label htmlFor="ah-name">Name</label>
        <input
          id="ah-name"
          type="text"
          value={name}
          placeholder="External helper"
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="ah-spec">Specialization</label>
        <ComboInput
          id="ah-spec"
          value={spec}
          placeholder="e.g. Backend"
          options={specOptions}
          onChange={setSpec}
          onCommit={setSpec}
        />
      </div>
      <div className="field">
        <label htmlFor="ah-speed">Speed</label>
        <input
          id="ah-speed"
          type="number"
          className="helper-speed"
          min="0.1"
          step="0.1"
          value={speed}
          onChange={(e) => setSpeed(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="ah-from">From</label>
        <input
          id="ah-from"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="ah-to">To</label>
        <input
          id="ah-to"
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      <Button type="submit" variant="primary" icon="plus">
        Add helper
      </Button>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
