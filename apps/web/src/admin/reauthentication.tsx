import { TOTP_CODE_DIGITS, problemTypes, type Reauthentication } from "@not-unreachable/contracts";
import { Alert, CodeInput, PasswordInput, SegmentedControl } from "@not-unreachable/design-system";
import { useState } from "react";
import type * as React from "react";
import { ApiError, api } from "../api/index.ts";
import { isProblem } from "../lib/index.ts";
import { PasskeyFailureAlert, signWithPasskey, useCanConfirmWithPasskey } from "../second-factors/index.ts";

/**
 * The proof of both factors that a root action (allowing a folder, installing an update) asks for
 * every time: the password, then an authenticator code or a passkey.
 */

export type SecondFactorMethod = "code" | "passkey";

const methodOptions = [
  { value: "code", label: "Authenticator code" },
  { value: "passkey", label: "Passkey" },
];

function isSecondFactorMethod(value: string): value is SecondFactorMethod {
  return value === "code" || value === "passkey";
}

/** What the admin typed and chose; a passkey is asked of the browser only on submit. */
export interface ReauthenticationDraft {
  readonly password: string;
  readonly method: SecondFactorMethod;
  readonly code: string;
}

/** The request's `reauthentication`: runs the passkey ceremony when the passkey was chosen. */
export async function proveReauthentication(draft: ReauthenticationDraft): Promise<Reauthentication> {
  const secondFactor =
    draft.method === "passkey" ? { passkey: await signWithPasskey(await api("startPasskeyConfirmation")) } : { code: draft.code };
  return { password: draft.password, secondFactor };
}

/** The words for a proof the server refused (401); undefined for any other error. */
export function reauthenticationErrorOf(error: unknown, method: SecondFactorMethod): string | undefined {
  if (isProblem(error, problemTypes.signInFailed)) return "The password is not right.";
  if (isProblem(error, problemTypes.secondFactorFailed) && method === "passkey")
    return "The passkey was not accepted. Try again, or use a code from your authenticator app.";
  if (isProblem(error, problemTypes.secondFactorFailed)) return "The code is not right. Check the code in your app and try again.";
  return undefined;
}

/**
 * Whether the request failed because the service went away under it: no answer at all, or a proxy's
 * 502, 503 or 504 rather than the app's own problem. A root action restarts the service, so this is
 * the restart as well.
 */
export function isDroppedConnection(error: unknown): boolean {
  if (!(error instanceof ApiError)) return error instanceof TypeError;
  return error.type === "about:blank" && (error.status === 502 || error.status === 503 || error.status === 504);
}

/** The form's state, and its check before anything is sent. */
export function useReauthenticationForm(open: boolean) {
  const [method, setMethod] = useState<SecondFactorMethod>("code");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const hasPasskeys = useCanConfirmWithPasskey(open);

  /** The draft to send, or null after saying what is missing. */
  const validate = (): ReauthenticationDraft | null => {
    if (password === "") setError("Enter your password.");
    else if (method === "code" && code.length !== TOTP_CODE_DIGITS)
      setError(`Enter the ${TOTP_CODE_DIGITS}-digit code from your authenticator app.`);
    else {
      setError(null);
      return { password, method, code };
    }
    return null;
  };

  /** Shows why the server refused; a wrong code is cleared to type again. */
  const refused = (message: string, caught: unknown) => {
    setError(message);
    if (method === "code" && isProblem(caught, problemTypes.secondFactorFailed)) setCode("");
  };

  return { method, setMethod, password, setPassword, code, setCode, error, setError, hasPasskeys, validate, refused };
}

export type ReauthenticationForm = ReturnType<typeof useReauthenticationForm>;

export interface ReauthenticationFieldsProps {
  readonly form: ReauthenticationForm;
  /** The password field, which the dialog focuses first. */
  readonly passwordRef: React.Ref<HTMLInputElement>;
  /** The submit button's label, which the passkey hint names. */
  readonly submitLabel: string;
  /** The request's error, for the passkey ceremony's own alert. */
  readonly requestError: unknown;
  /** The method changed: the caller forgets the last request's error. */
  readonly onMethodChange: () => void;
}

/** The error, the password and the second step, inside the caller's form. */
export function ReauthenticationFields({ form, passwordRef, submitLabel, requestError, onMethodChange }: ReauthenticationFieldsProps) {
  return (
    <>
      {form.error !== null && <Alert tone="danger">{form.error}</Alert>}
      <PasswordInput ref={passwordRef} label="Password" value={form.password} onChange={(event) => form.setPassword(event.target.value)} />
      <div className="flex flex-col gap-3">
        <p className="m-0 type-label text-fg-1">Second step</p>
        {form.hasPasskeys && (
          <SegmentedControl
            aria-label="Second step"
            options={methodOptions}
            value={form.method}
            onChange={(value) => {
              if (!isSecondFactorMethod(value)) return;
              form.setMethod(value);
              form.setError(null);
              onMethodChange();
            }}
          />
        )}
        {form.method === "passkey" && <PasskeyFailureAlert error={requestError} />}
        {form.method === "passkey" ? (
          <p className="m-0 type-body-sm text-fg-2">Select {submitLabel}, then follow your browser's steps to use one of your passkeys.</p>
        ) : (
          <CodeInput label="Authenticator code" value={form.code} onChange={form.setCode} />
        )}
      </div>
    </>
  );
}
