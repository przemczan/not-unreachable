import { TOTP_CODE_DIGITS, type TotpEnrolment } from "@not-unreachable/contracts";
import { CodeInput, QrCodePanel } from "@not-unreachable/design-system";
import { useState } from "react";
import type * as React from "react";
import { errorProp } from "../lib/index.ts";

export const missingCodeMessage = `Enter the ${TOTP_CODE_DIGITS}-digit code from your authenticator app.`;

export interface AuthenticatorSetupProps {
  readonly enrolment: TotpEnrolment;
  /** Called with a whole code. */
  readonly onSubmit: (code: string) => void;
  /** Why the server refused the last code. */
  readonly error?: string | null;
  /** The form's id, for a submit button outside it (a Dialog's actions). */
  readonly id?: string;
  /** Under the code: the submit button, when it is inside the form. */
  readonly children?: React.ReactNode;
}

/** Adding an authenticator app: scan the QR code (or type in the setup key), then prove it with a code. */
export function AuthenticatorSetup({ enrolment, onSubmit, error = null, id, children }: AuthenticatorSetupProps) {
  const [code, setCode] = useState("");
  const [missing, setMissing] = useState(false);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const complete = code.length === TOTP_CODE_DIGITS;
    setMissing(!complete);
    if (complete) onSubmit(code);
  };

  return (
    <form id={id} noValidate onSubmit={submit} className="flex flex-col gap-4">
      <ol className="m-0 flex list-none flex-col gap-4 p-0">
        <li className="flex flex-col gap-2">
          <p className="m-0 type-body-sm text-fg-2">1. Scan this QR code with your authenticator app, or type in the setup key.</p>
          <QrCodePanel qrCode={enrolment.qrCode} alt="QR code for your authenticator app" setupKey={enrolment.setupKey} />
        </li>
        <li className="flex flex-col gap-2">
          <p className="m-0 type-body-sm text-fg-2">2. Enter the code the app shows.</p>
          <CodeInput
            label="Authenticator code"
            value={code}
            onChange={(next) => {
              setCode(next);
              setMissing(false);
            }}
            {...errorProp(missing ? missingCodeMessage : (error ?? undefined))}
          />
        </li>
      </ol>
      {children}
    </form>
  );
}
