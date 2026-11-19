import { useState, type FormEvent } from "react";
import { todayISO } from "@planner/core";
import { Button } from "../ui/Button";

interface NewProjectFormProps {
  onCreate: (name: string, startDate: string) => void;
}

export function NewProjectForm({ onCreate }: NewProjectFormProps) {
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
    <form className="card new-project-card" onSubmit={handleSubmit}>
      <h3 className="new-project-heading">New project</h3>
      <div className="new-project-form">
        <div className="field">
          <label htmlFor="np-name">Name</label>
          <input
            id="np-name"
            type="text"
            value={name}
            placeholder="e.g. Q4 Roadmap"
            className="np-name-input"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="np-start">Start date</label>
          <input
            id="np-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <Button type="submit" variant="primary" disabled={!trimmed}>
          + Create project
        </Button>
      </div>
    </form>
  );
}
