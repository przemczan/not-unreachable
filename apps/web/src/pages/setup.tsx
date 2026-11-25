import {
  displayNameSchema,
  emailSchema,
  problemTypes,
  setupTokenSchema,
  USERNAME_PATTERN,
  type SetupRequest,
} from "@not-unreachable/contracts";
import { Alert, AuthLayout, Button, Input, PasswordInput } from "@not-unreachable/design-system";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type * as React from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError, api } from "../api/index.ts";
import { breachedPasswordMessage, errorProp, isProblem, newPasswordErrors, newPasswordHint, problemMessage } from "../lib/index.ts";
import { setupStatusQuery, setupStatusQueryKey } from "../session/index.ts";
import type { SignInNotice } from "./sign-in.tsx";

/** The setup token travels in the URL fragment (`/setup#<token>`), which never reaches a server log. */
function tokenOf(hash: string): string | null {
  const parsed = setupTokenSchema.safeParse(hash.replace(/^#/, ""));
  return parsed.success ? parsed.data : null;
}

function InvalidLink({ command }: { readonly command: string }) {
  return (
    <Alert tone="danger" title="This setup link is not valid">
      Run <code className="type-mono">not-unreachable {command}</code> on the server for a new one.
    </Alert>
  );
}

export function Component() {
  const location = useLocation();
  const navigate = useNavigate();
  const status = useQuery(setupStatusQuery);
  // Kept in state because the effect below takes the token out of the address bar and the history entry.
  // Opening another link in a tab already on /setup only changes the hash, so the page doesn't remount:
  // take up any new valid token while rendering, and ignore a hash that isn't one.
  const hashToken = tokenOf(location.hash);
  const [token, setToken] = useState(hashToken);
  const [linkInvalid, setLinkInvalid] = useState(false);
  if (hashToken !== null && hashToken !== token) {
    setToken(hashToken);
    setLinkInvalid(false);
  }

  useEffect(() => {
    if (location.hash !== "") void navigate({ pathname: location.pathname, search: location.search }, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);

  if (status.data === undefined) return null;
  const adminExists = status.data.adminExists;
  const title = adminExists ? "Set a new admin password" : "Create the admin account";
  const command = adminExists ? "reset-admin" : "setup-link";

  return (
    <AuthLayout title={title} footer="Every setup step is logged.">
      {token === null || linkInvalid ? (
        <InvalidLink command={command} />
      ) : (
        <SetupForm key={token} token={token} adminExists={adminExists} onInvalidLink={() => setLinkInvalid(true)} />
      )}
    </AuthLayout>
  );
}

interface SetupFormProps {
  readonly token: string;
  readonly adminExists: boolean;
  readonly onInvalidLink: () => void;
}

type FieldName = "username" | "email" | "displayName" | "password" | "confirmation";
type FieldErrors = Partial<Record<FieldName, string>>;

const usernameHint = "3–32 lowercase letters, digits, dots, dashes or underscores. It can't be changed later.";

function SetupForm({ token, adminExists, onInvalidLink }: SetupFormProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<FieldName, string>>({
    username: "",
    email: "",
    displayName: "",
    password: "",
    confirmation: "",
  });
  const [errors, setErrors] = useState<FieldErrors>({});

  const setup = useMutation({
    mutationFn: (request: SetupRequest) => api("setup", { body: request }),
    onSuccess: () => {
      queryClient.setQueryData(setupStatusQueryKey, { adminExists: true });
      const notice: SignInNotice = adminExists ? "admin-password-set" : "admin-created";
      void navigate("/sign-in", { replace: true, state: { notice } });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) onInvalidLink();
      else if (isProblem(error, problemTypes.breachedPassword)) setErrors({ password: breachedPasswordMessage });
    },
  });

  const field = (name: FieldName) => ({
    value: values[name],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setValues((current) => ({ ...current, [name]: event.target.value })),
    ...errorProp(errors[name]),
  });

  const validate = (): FieldErrors => {
    const found: FieldErrors = newPasswordErrors(values.password, values.confirmation);
    if (adminExists) return found;
    if (!USERNAME_PATTERN.test(values.username)) found.username = "Use 3–32 lowercase letters, digits, dots, dashes or underscores.";
    if (!emailSchema.safeParse(values.email.trim()).success) found.email = "Enter an email address, such as name@example.com.";
    if (!displayNameSchema.safeParse(values.displayName).success) found.displayName = "Enter a name of up to 100 characters.";
    return found;
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setup.mutate(
      adminExists
        ? { token, password: values.password }
        : {
            token,
            username: values.username,
            email: values.email.trim(),
            displayName: values.displayName.trim(),
            password: values.password,
          },
    );
  };

  const showGeneralError = setup.isError && !isProblem(setup.error, problemTypes.breachedPassword);

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      {showGeneralError && <Alert tone="danger">{problemMessage(setup.error, "Setup did not work. Try again.")}</Alert>}
      {!adminExists && (
        <>
          <Input
            label="Username"
            hint={usernameHint}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            {...field("username")}
          />
          <Input label="Email" type="email" autoComplete="email" {...field("email")} />
          <Input label="Display name" autoComplete="name" {...field("displayName")} />
        </>
      )}
      <PasswordInput
        label={adminExists ? "New password" : "Password"}
        autoComplete="new-password"
        hint={newPasswordHint}
        {...field("password")}
      />
      <PasswordInput label="Confirm password" autoComplete="new-password" {...field("confirmation")} />
      <Button type="submit" variant="accent" size="lg" fullWidth loading={setup.isPending}>
        {adminExists ? "Set password" : "Create admin account"}
      </Button>
    </form>
  );
}
