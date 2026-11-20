import { useState, type FormEvent } from "react";
import { todayISO } from "@planner/core";
import { Button } from "../ui/Button";
import { Field } from "../ui/IconTile";

interface NewProjectFormProps {
  onCreate: (name: string, startDate: string) => void;
  /** Shows a Cancel button (the form lives in a modal on the dashboard). */
  onCancel?: () => void;
}

export function NewProjectForm({ onCreate, onCancel }: NewProjectFormProps) {
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState(todayISO());

  const trimmed = name.trim();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    onCreate(trimmed, startDate);
    setName("");
    setStartDate(todayISO());
  }

  return (
    <form className="new-project-form" onSubmit={handleSubmit}>
      <Field label="Name" htmlFor="np-name">
        <input
          id="np-name"
          type="text"
          value={name}
          placeholder="e.g. Q4 Roadmap"
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field
        label="Start date"
        htmlFor="np-start"
        hint="The scheduler plans work from this day on."
      >
        <input
          id="np-start"
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
        />
      </Field>
      <div className="modal-actions">
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" icon="plus" disabled={!trimmed}>
          Create project
        </Button>
      </div>
    </form>
  );
}
