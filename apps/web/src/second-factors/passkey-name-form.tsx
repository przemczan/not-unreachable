import { PASSKEY_NAME_MAX_CHARACTERS } from "@not-unreachable/contracts";
import { Input } from "@not-unreachable/design-system";
import { useState } from "react";
import type * as React from "react";
import { errorProp } from "../lib/index.ts";

export interface PasskeyNameFormProps {
  /** Called with the trimmed name, once it is fine. */
  readonly onSubmit: (name: string) => void;
  /** The name to start from, when renaming. */
  readonly initialName?: string;
  /** Whether the name is being saved, so the field waits. */
  readonly loading?: boolean;
  /** The form's id, for a submit button outside it (a Dialog's actions). */
  readonly id?: string;
  /** Under the field: the submit button, when it is inside the form. */
  readonly children?: React.ReactNode;
  /** `lg` in AuthLayout, as its other fields. */
  readonly size?: "md" | "lg";
}

/** Naming a passkey, to add it or rename it: the name tells the admin's passkeys apart. */
export function PasskeyNameForm({ onSubmit, initialName = "", loading = false, id, children, size = "md" }: PasskeyNameFormProps) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") setError("Enter a name for the passkey.");
    else if (trimmed.length > PASSKEY_NAME_MAX_CHARACTERS) setError(`Use at most ${PASSKEY_NAME_MAX_CHARACTERS} characters.`);
    else onSubmit(trimmed);
  };

  return (
    <form id={id} noValidate onSubmit={submit} className="flex flex-col gap-4">
      <Input
        size={size}
        label="Passkey name"
        hint="Such as Phone or YubiKey, so you can tell your passkeys apart."
        autoComplete="off"
        readOnly={loading}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setError(undefined);
        }}
        {...errorProp(error)}
      />
      {children}
    </form>
  );
}
