import { routes } from "@not-unreachable/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const SECRET_LOOKING = /password|passphrase|secret|token|code|hash|key|cookie|otp|credential|salt|private|bearer|auth/i;

/**
 * Response fields that match the pattern but are no stored secret, each with why (threat model,
 * T6: secrets never leave the server). Anything new here needs the same scrutiny.
 */
const allowed = new Set<string>([
  // The authenticator app's secret, shown while it is enrolled and not yet confirmed: the one exception T6 names.
  "startTotpEnrolment.200.setupKey",
  "startTotpEnrolment.200.qrCode",
  "addTotp.200.setupKey",
  "addTotp.200.qrCode",
  // Recovery codes, shown once when they are made and never again (T10); only their hashes are stored.
  "confirmTotpEnrolment.200.recoveryCodes",
  "confirmPasskeyEnrolment.200.recoveryCodes",
  "regenerateRecoveryCodes.200.recoveryCodes",
  "addPasskey.200.recoveryCodes",
  // How many recovery codes are left, not the codes.
  "getSecondFactors.200.recoveryCodes",
  // A passkey's name and dates; its fields are checked one by one like any other.
  "listPasskeys.200.passkeys",
  "addPasskey.200.passkey",
  // WebAuthn options: public credential ids, algorithms and authenticator requirements.
  "startPasskeyConfirmation.200.allowCredentials",
  "startPasskeySignIn.200.allowCredentials",
  "startPasskeySecondFactor.200.allowCredentials",
  "startPasskeyEnrolment.200.pubKeyCredParams",
  "startPasskeyEnrolment.200.excludeCredentials",
  "startPasskeyEnrolment.200.authenticatorSelection",
  "startPasskeyRegistration.200.pubKeyCredParams",
  "startPasskeyRegistration.200.excludeCredentials",
  "startPasskeyRegistration.200.authenticatorSelection",
]);

interface Field {
  readonly path: string;
  readonly schema: z.core.$ZodType;
}

/** Every field of a schema, nested ones too, at `route.status.path`. */
function fieldsOf(schema: z.core.$ZodType, path: string, seen: Set<z.core.$ZodType> = new Set()): Field[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape).flatMap(([name, field]) => [
      { path: `${path}.${name}`, schema: field },
      ...fieldsOf(field, `${path}.${name}`, seen),
    ]);
  }
  if (schema instanceof z.ZodArray) return fieldsOf(schema.element, path, seen);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
    return fieldsOf(schema.unwrap(), path, seen);
  }
  if (schema instanceof z.ZodUnion) return schema.options.flatMap((option) => fieldsOf(option, path, seen));
  if (schema instanceof z.ZodIntersection) return [...fieldsOf(schema.def.left, path, seen), ...fieldsOf(schema.def.right, path, seen)];
  if (schema instanceof z.ZodPipe) return [...fieldsOf(schema.in, path, seen), ...fieldsOf(schema.out, path, seen)];
  if (schema instanceof z.ZodRecord) return fieldsOf(schema.valueType, `${path}.*`, seen);
  if (schema instanceof z.ZodLazy) return fieldsOf(schema.unwrap(), path, seen);
  if (schema instanceof z.ZodReadonly) return fieldsOf(schema.unwrap(), path, seen);
  return [];
}

const responseFields = Object.entries(routes).flatMap(([name, route]) =>
  Object.entries(route.responses).flatMap(([status, schema]) => (schema === undefined ? [] : fieldsOf(schema, `${name}.${status}`))),
);

const lastName = (path: string) => path.slice(path.lastIndexOf(".") + 1);

/** A flag such as `smbPasswordSet` or `hasPassword` says whether a secret exists, never what it is. */
function isFlag(schema: z.core.$ZodType): boolean {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) return isFlag(schema.unwrap());
  return schema instanceof z.ZodBoolean;
}

const suspicious = (fields: readonly Field[]): string[] =>
  fields.filter((field) => SECRET_LOOKING.test(lastName(field.path)) && !isFlag(field.schema)).map((field) => field.path);

describe("response schemas (T6)", () => {
  it("have fields to check", () => {
    expect(responseFields.length).toBeGreaterThan(100);
  });

  it("have no secret-looking field", () => {
    expect(suspicious(responseFields).filter((path) => !allowed.has(path))).toEqual([]);
  });

  it("allow only fields that exist", () => {
    const paths = new Set(responseFields.map((field) => field.path));
    expect([...allowed].filter((path) => !paths.has(path))).toEqual([]);
  });

  it("see a secret-looking field when one is there, but not a flag", () => {
    const schema = z.strictObject({ items: z.array(z.strictObject({ clientSecret: z.string().optional(), passwordSet: z.boolean() })) });
    expect(suspicious(fieldsOf(schema, "test"))).toEqual(["test.items.clientSecret"]);
  });
});
