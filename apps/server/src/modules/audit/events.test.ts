import { auditActions } from "@not-unreachable/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { auditDetailsSchemas } from "./events.ts";

const SECRET_LOOKING = /pass|secret|token|code|hash|key|cookie|otp|credential|salt|nonce|private|content|bearer|auth/i;

/**
 * Field names that match the pattern but hold no secret, each with why. Anything new here needs
 * the same scrutiny (threat model, T12).
 */
const allowed = new Set([
  // The names of the settings that changed, never their values.
  "settings.changed.keys",
  // The rate limit's bucket (such as an IP address or a username), never a credential.
  "rate-limit.triggered.key",
  // Whether a share link has a password, never the password.
  "share-link.created.hasPassword",
  "share-link.changed.hasPassword",
  // Ids of master keys (a fingerprint), never key material.
  "system.key-rotated.oldKeyId",
  "system.key-rotated.newKeyId",
  // The id of the release signing key that verified an update (a public key's fingerprint).
  "update.finished.signingKey",
]);

interface Field {
  readonly path: string;
  readonly schema: z.core.$ZodType;
}

const lastName = (path: string) => path.slice(path.lastIndexOf(".") + 1);

/** Every field of a details schema, nested ones too, and every object in it. */
function walk(schema: z.core.$ZodType, path: string, fields: Field[], objects: z.ZodObject[]): void {
  if (schema instanceof z.ZodObject) {
    objects.push(schema);
    for (const [name, field] of Object.entries(schema.shape)) {
      fields.push({ path: `${path}.${name}`, schema: field });
      walk(field, `${path}.${name}`, fields, objects);
    }
  } else if (schema instanceof z.ZodArray) {
    walk(schema.element, path, fields, objects);
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    walk(schema.unwrap(), path, fields, objects);
  } else if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) walk(option, path, fields, objects);
  }
}

describe("auditDetailsSchemas", () => {
  it("has a schema for every action", () => {
    expect(Object.keys(auditDetailsSchemas).toSorted()).toEqual([...auditActions].toSorted());
  });

  it.each(auditActions)("%s has no secret-looking field", (action) => {
    const fields: Field[] = [];
    walk(auditDetailsSchemas[action], action, fields, []);
    const suspicious = fields.map((field) => field.path).filter((path) => SECRET_LOOKING.test(lastName(path)) && !allowed.has(path));
    expect(suspicious).toEqual([]);
  });

  it.each(auditActions)("%s is strict all the way down", (action) => {
    const objects: z.ZodObject[] = [];
    walk(auditDetailsSchemas[action], action, [], objects);
    expect(objects.length).toBeGreaterThan(0);
    for (const object of objects) expect(object.def.catchall).toBeInstanceOf(z.ZodNever);
    const result = auditDetailsSchemas[action].safeParse({ unexpected: "x" });
    // A union's options each refuse the key, inside its `invalid_union` issue.
    const flatten = (issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] =>
      issues.flatMap((issue) => (issue.code === "invalid_union" ? issue.errors.flatMap(flatten) : [issue]));
    expect(flatten(result.error?.issues ?? [])).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys", keys: ["unexpected"] }),
    );
  });

  it("sees a secret-looking field when one is there", () => {
    const fields: Field[] = [];
    walk(z.strictObject({ nested: z.array(z.strictObject({ passwordHash: z.string() })) }), "test", fields, []);
    expect(fields.map((field) => field.path).filter((path) => SECRET_LOOKING.test(path))).toEqual(["test.nested.passwordHash"]);
  });

  it("allows only fields that exist", () => {
    const paths = new Set<string>();
    for (const action of auditActions) {
      const fields: Field[] = [];
      walk(auditDetailsSchemas[action], action, fields, []);
      for (const field of fields) paths.add(field.path);
    }
    expect([...allowed].filter((path) => !paths.has(path))).toEqual([]);
  });
});
