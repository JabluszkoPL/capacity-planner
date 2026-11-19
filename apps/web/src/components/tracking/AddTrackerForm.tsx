import { useState, type FormEvent } from "react";
import { parseIssueLink } from "@planner/jira";
import { Button } from "../ui/Button";

interface AddTrackerFormProps {
  /** Used when the pasted text is a bare key with no site in it. */
  fallbackBaseUrl: string;
  onAdd: (link: { url: string; key: string; baseUrl: string }) => void;
}

/**
 * What to tell the user for each way parsing can fail.
 *
 * `no-host` covers two situations — a bare key with no Jira site configured,
 * and text that is not a link at all — so its wording names the remedy for
 * both rather than guessing which one happened and being wrong half the time.
 */
const MESSAGES: Record<string, string> = {
  "no-key":
    "That link has no issue key in it. Paste a link to the initiative, or its key like ABC-123.",
  "no-host":
    "Planner can't tell which Jira site that is. Paste the full link, or set your Jira URL in Settings and paste just the key.",
  "untrusted-host":
    "That link doesn't point at a Jira site. Paste a link from your own Jira.",
};

export function AddTrackerForm({
  fallbackBaseUrl,
  onAdd,
}: AddTrackerFormProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const raw = value.trim();
    if (!raw) return;
    const parsed = parseIssueLink(raw, fallbackBaseUrl || undefined);
    if (!parsed.ok) {
      setError(MESSAGES[parsed.reason] ?? "That link could not be read.");
      return;
    }
    setError(null);
    setValue("");
    onAdd({ url: raw, key: parsed.key, baseUrl: parsed.baseUrl });
  }

  return (
    <form className="card add-tracker" onSubmit={submit}>
      <h3 className="add-tracker-heading">Track a Jira initiative</h3>
      <div className="add-tracker-row">
        <div className="field grow">
          <label htmlFor="tracker-link">Initiative link or key</label>
          <input
            id="tracker-link"
            type="text"
            value={value}
            placeholder="https://your-company.atlassian.net/browse/ABC-123"
            aria-invalid={error !== null}
            aria-describedby={error ? "tracker-link-error" : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
          />
        </div>
        <Button type="submit" variant="primary" disabled={!value.trim()}>
          + Add tracker
        </Button>
      </div>
      {error && (
        <p className="field-error" id="tracker-link-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
