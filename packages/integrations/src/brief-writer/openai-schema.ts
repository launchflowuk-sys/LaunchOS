import { z } from "zod";
import { StructuredBrief } from "./types.js";

/**
 * The brief's own schema, in the shape OpenAI's strict structured outputs take.
 *
 * The writer used to ask for `json_object` — "any JSON" — while its prompt said
 * "matching the supplied schema", and no schema was ever supplied. The model
 * invented a shape of its own, every reply failed validation, and the sweep
 * paid for the same failure every five minutes. Handing over the real schema
 * with `strict: true` makes the model's reply fit it by construction.
 *
 * Derived from the Zod definition rather than written out by hand, so the
 * schema the model is held to and the schema the reply is checked against
 * cannot drift apart. Strict mode is pickier than JSON Schema, so the Zod
 * output is reshaped:
 *
 * - every object is closed and lists every property as required;
 * - a property Zod calls optional becomes required-but-nullable instead, and
 *   `dropNulls` turns those nulls back into absent keys before Zod reads them;
 * - `const` becomes a one-value `enum`;
 * - length and count limits are left out. Zod still enforces every one of them
 *   on the reply, so nothing is loosened — the model just is not told twice.
 */

type JsonSchema = Record<string, unknown>;

const LEFT_OUT = new Set(["$schema", "minLength", "maxLength", "minItems", "maxItems", "pattern", "format", "default"]);

function nullable(node: JsonSchema): JsonSchema {
  if (typeof node.type === "string") {
    return {
      ...node,
      type: [node.type, "null"],
      ...(Array.isArray(node.enum) ? { enum: [...node.enum, null] } : {}),
    };
  }
  return { anyOf: [node, { type: "null" }] };
}

function toStrict(node: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (LEFT_OUT.has(key) || key === "properties" || key === "required" || key === "additionalProperties") continue;
    if (key === "const") out.enum = [value];
    else if (key === "items") out.items = toStrict(value as JsonSchema);
    else if (key === "anyOf") out.anyOf = (value as JsonSchema[]).map(toStrict);
    else out[key] = value;
  }

  if (node.properties && typeof node.properties === "object") {
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    const properties = Object.fromEntries(
      Object.entries(node.properties as Record<string, JsonSchema>).map(([name, child]) => {
        const shaped = toStrict(child);
        return [name, required.has(name) ? shaped : nullable(shaped)];
      }),
    );
    out.properties = properties;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

let cached: JsonSchema | undefined;

/** Built once: the schema is a constant, and it is sent with every brief. */
export function briefJsonSchema(): JsonSchema {
  cached ??= toStrict(z.toJSONSchema(StructuredBrief) as JsonSchema);
  return cached;
}

/**
 * The reply with every `null` object value removed, as a new value.
 *
 * Strict mode sends `null` for a field it has nothing for; Zod's `.optional()`
 * means "absent", not "null". A `null` in a field that is actually required
 * is removed too, and Zod then refuses the reply for the missing field — which
 * is the right answer.
 */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== null)
        .map(([key, entry]) => [key, dropNulls(entry)]),
    );
  }
  return value;
}
