import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";

interface AddMemberFormProps {
  onAdd: (name: string, specialization: string) => void;
  /** Suffix to keep input ids unique when several forms share a page. */
  idSuffix?: string;
}

/** The "add a person" strip at the foot of a team's roster. */
export function AddMemberForm({ onAdd, idSuffix = "" }: AddMemberFormProps) {
  const [name, setName] = useState("");
  const [spec, setSpec] = useState("");
  const [error, setError] = useState<string | null>(null);
  const nameId = "nm-name" + idSuffix;
  const specId = "nm-spec" + idSuffix;
  const errorId = "nm-error" + idSuffix;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Please enter a name.");
      return;
    }
    onAdd(trimmed, spec.trim());
    setName("");
    setSpec("");
    setError(null);
  }

  return (
    <form className="add-member-form" onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor={nameId}>Name</label>
        <input
          id={nameId}
          type="text"
          value={name}
          placeholder="Full name"
          className="nm-name-input"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
        />
      </div>
      <div className="field">
        <label htmlFor={specId}>Specialization</label>
        <input
          id={specId}
          type="text"
          list="spec-list"
          value={spec}
          placeholder="e.g. Frontend"
          className="nm-spec-input"
          onChange={(e) => setSpec(e.target.value)}
        />
      </div>
      <Button type="submit" icon="plus">
        Add person
      </Button>
      {error && (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
