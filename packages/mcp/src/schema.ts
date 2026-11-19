/**
 * Tool definitions and the argument checks that go with them.
 *
 * Each tool's `inputSchema` is plain JSON Schema, sent to the client as is.
 * The same object is then the validator: {@link checkArgs} understands the
 * small subset the catalogue uses, so the schema a model is shown and the rule
 * its arguments are held to can never drift apart. Hand-written, like the sync
 * protocol's type guards, rather than a schema library.
 */

/**
 * Who may call a tool.
 *
 *  - `read`: reads the data. Allowed whenever MCP is on.
 *  - `view`: changes what the open window shows. Also allowed whenever MCP is
 *    on - a few of these (a tracker's team selection, a plan's view mode) are
 *    saved with the data, but they only change how it is shown.
 *  - `write`: changes plans, teams or people. Only with "Allow changes" on.
 */
export type ToolAccess = "read" | "view" | "write";

export type JsonSchema =
  | {
      type: "string";
      description?: string;
      enum?: readonly string[];
      /** `date` = YYYY-MM-DD; `date-or-range` also allows `from..to`. */
      format?: "date" | "date-or-range";
      minLength?: number;
    }
  | {
      type: "number" | "integer";
      description?: string;
      minimum?: number;
      maximum?: number;
    }
  | { type: "boolean"; description?: string }
  | {
      type: "array";
      description?: string;
      items: JsonSchema;
      maxItems?: number;
    }
  | ObjectSchema;

export interface ObjectSchema {
  type: "object";
  description?: string;
  properties: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties: false;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  /** Always false: no tool reaches anything outside the app. */
  openWorldHint: false;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  access: ToolAccess;
  inputSchema: ObjectSchema;
  annotations: ToolAnnotations;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD form (no 2026-02-30). */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function isDateOrRange(value: string): boolean {
  const parts = value.split("..");
  if (parts.length === 1) return isIsoDate(value);
  return (
    parts.length === 2 &&
    isIsoDate(parts[0]) &&
    isIsoDate(parts[1]) &&
    parts[0] <= parts[1]
  );
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function check(
  schema: JsonSchema,
  value: unknown,
  path: string,
): string | null {
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") {
        return `${path} must be a string, not ${typeName(value)}.`;
      }
      if (
        schema.minLength !== undefined &&
        value.trim().length < schema.minLength
      ) {
        return `${path} must not be empty.`;
      }
      if (schema.enum && !schema.enum.includes(value)) {
        return `${path} must be one of: ${schema.enum.join(", ")}.`;
      }
      if (schema.format === "date" && !isIsoDate(value)) {
        return `${path} must be a date as YYYY-MM-DD, not "${value}".`;
      }
      if (schema.format === "date-or-range" && !isDateOrRange(value)) {
        return `${path} must be YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD, not "${value}".`;
      }
      return null;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `${path} must be a number.`;
      }
      if (schema.type === "integer" && !Number.isInteger(value)) {
        return `${path} must be a whole number.`;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return `${path} must be at least ${schema.minimum}.`;
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return `${path} must be at most ${schema.maximum}.`;
      }
      return null;
    }
    case "boolean":
      return typeof value === "boolean"
        ? null
        : `${path} must be true or false.`;
    case "array": {
      if (!Array.isArray(value)) return `${path} must be a list.`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${path} may hold at most ${schema.maxItems} items.`;
      }
      for (let i = 0; i < value.length; i++) {
        const err = check(schema.items, value[i], `${path}[${i}]`);
        if (err) return err;
      }
      return null;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `${path} must be an object.`;
      }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (record[key] === undefined) return `${path}.${key} is required.`;
      }
      for (const [key, v] of Object.entries(record)) {
        const sub = schema.properties[key];
        if (!sub) {
          const known = Object.keys(schema.properties);
          return `${path}.${key} is not a known argument${
            known.length ? ` (expected ${known.join(", ")})` : ""
          }.`;
        }
        if (v === undefined) continue;
        const err = check(sub, v, `${path}.${key}`);
        if (err) return err;
      }
      return null;
    }
  }
}

/** Null when `args` fits the schema, else a sentence saying what is wrong. */
export function checkArgs(schema: ObjectSchema, args: unknown): string | null {
  return check(schema, args, "arguments");
}
