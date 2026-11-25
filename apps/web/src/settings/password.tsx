import { problemTypes } from "@not-unreachable/contracts";
import { Alert, Button, Card, PasswordInput, useToast } from "@not-unreachable/design-system";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type * as React from "react";
import { api } from "../api/index.ts";
import { SettingsRow } from "../layout/index.ts";
import { breachedPasswordMessage, errorProp, isProblem, newPasswordErrors, newPasswordHint, problemMessage } from "../lib/index.ts";
import { isRecentSignInCancelled, useRecentSignIn } from "../session/index.ts";
import { sessionsQueryKey } from "./sessions.tsx";

type FieldName = "current" | "password" | "confirmation";
type FieldErrors = Partial<Record<FieldName, string>>;

const emptyValues: Record<FieldName, string> = { current: "", password: "", confirmation: "" };

export function PasswordSettings() {
  const id = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { run } = useRecentSignIn();
  const [values, setValues] = useState(emptyValues);
  const [errors, setErrors] = useState<FieldErrors>({});

  const change = useMutation({
    mutationFn: () => run(() => api("changePassword", { body: { currentPassword: values.current, newPassword: values.password } })),
    onSuccess: () => {
      setValues(emptyValues);
      // Every other session was signed out.
      void queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
      toast.show({ tone: "success", title: "Password changed", description: "Your other sessions were signed out." });
    },
    onError: (error) => {
      if (isProblem(error, problemTypes.breachedPassword)) setErrors({ password: breachedPasswordMessage });
      else if (isProblem(error, problemTypes.signInFailed)) setErrors({ current: "The current password is not right." });
    },
  });

  const field = (name: FieldName) => ({
    id: `${id}-${name}`,
    value: values[name],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setValues((current) => ({ ...current, [name]: event.target.value })),
    ...errorProp(errors[name]),
  });

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found: FieldErrors = newPasswordErrors(values.password, values.confirmation);
    if (values.current === "") found.current = "Enter your current password.";
    setErrors(found);
    if (Object.keys(found).length === 0) change.mutate();
  };

  const fieldProblem =
    isProblem(change.error, problemTypes.breachedPassword) ||
    isProblem(change.error, problemTypes.signInFailed) ||
    isRecentSignInCancelled(change.error);

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      {change.isError && !fieldProblem && (
        <Alert tone="danger">{problemMessage(change.error, "Changing the password did not work. Try again.")}</Alert>
      )}
      <Card title="Password" subtitle="Changing it signs out every other session." padding="none" bodyClassName="px-5">
        <SettingsRow label="Current password" htmlFor={`${id}-current`}>
          <PasswordInput autoComplete="current-password" {...field("current")} />
        </SettingsRow>
        <SettingsRow label="New password" htmlFor={`${id}-password`}>
          <PasswordInput autoComplete="new-password" hint={newPasswordHint} {...field("password")} />
        </SettingsRow>
        <SettingsRow label="Confirm new password" htmlFor={`${id}-confirmation`}>
          <PasswordInput autoComplete="new-password" {...field("confirmation")} />
        </SettingsRow>
      </Card>
      <div className="flex justify-end">
        <Button type="submit" loading={change.isPending}>
          Change password
        </Button>
      </div>
    </form>
  );
}
