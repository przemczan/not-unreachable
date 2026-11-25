import {
  problemTypes,
  smtpTlsModes,
  updateMailSettingsRequestSchema,
  type SmtpSettings,
  type SmtpTlsMode,
  type UpdateMailSettingsRequest,
} from "@not-unreachable/contracts";
import { Alert, Button, Card, Input, PasswordInput, Select, useToast } from "@not-unreachable/design-system";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type * as React from "react";
import { api } from "../api/index.ts";
import { SettingsRow } from "../layout/index.ts";
import { errorProp, isProblem, problemMessage } from "../lib/index.ts";
import { isRecentSignInCancelled, useRecentSignIn } from "../session/index.ts";

export const mailSettingsQueryKey = ["admin", "settings", "mail"] as const;

const tlsModeLabels: Record<SmtpTlsMode, string> = {
  starttls: "STARTTLS",
  tls: "TLS",
  none: "None (this computer only)",
};

const tlsModeOptions = smtpTlsModes.map((mode) => ({ value: mode, label: tlsModeLabels[mode] }));

function tlsModeOf(value: string): SmtpTlsMode {
  return smtpTlsModes.find((mode) => mode === value) ?? "starttls";
}

const fieldNames = ["host", "port", "tlsMode", "username", "password", "fromAddress"] as const;
type FieldName = (typeof fieldNames)[number];
type Draft = Readonly<Record<FieldName, string>>;
type FieldErrors = Partial<Record<FieldName, string>>;

const fieldMessages: Record<FieldName, string> = {
  host: "Enter the SMTP server's host name, such as smtp.example.com.",
  port: "Enter a port from 1 to 65535, such as 587.",
  tlsMode: "Choose how the connection is secured.",
  username: "Enter a username of up to 500 characters, or leave it empty.",
  password: "Enter a password of up to 2000 characters.",
  fromAddress: "Enter an email address, such as files@example.com.",
};

function draftOf(smtp: SmtpSettings | null): Draft {
  return {
    host: smtp?.host ?? "",
    port: String(smtp?.port ?? 587),
    tlsMode: smtp?.tlsMode ?? "starttls",
    username: smtp?.username ?? "",
    password: "",
    fromAddress: smtp?.fromAddress ?? "",
  };
}

function isFieldName(value: unknown): value is FieldName {
  return fieldNames.some((name) => name === value);
}

/** The draft as the request, or the error of each field the contract refuses. */
function parseDraft(draft: Draft): { request: UpdateMailSettingsRequest } | { errors: FieldErrors } {
  const username = draft.username.trim();
  const port = draft.port.trim();
  const parsed = updateMailSettingsRequestSchema.safeParse({
    host: draft.host,
    port: port === "" ? Number.NaN : Number(port),
    tlsMode: tlsModeOf(draft.tlsMode),
    username: username === "" ? null : username,
    // Left out, the saved password stays; it only goes with a username.
    ...(draft.password === "" || username === "" ? {} : { password: draft.password }),
    fromAddress: draft.fromAddress.trim(),
  });
  if (parsed.success) return { request: parsed.data };
  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const [field] = issue.path;
    if (isFieldName(field)) errors[field] = fieldMessages[field];
  }
  return { errors };
}

/** Admin settings → Email: the SMTP server invitations and re-link links are emailed through. */
export function MailSettings() {
  const query = useQuery({ queryKey: mailSettingsQueryKey, queryFn: ({ signal }) => api("getMailSettings", { signal }) });

  if (query.isPending) return <p className="m-0 type-body-sm text-fg-3">Loading email settings…</p>;
  if (query.isError) {
    return (
      <Alert
        tone="danger"
        title="Email settings could not be loaded"
        action={
          <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      >
        {problemMessage(query.error, "Reload the page to try again.")}
      </Alert>
    );
  }
  return <MailSettingsForm saved={query.data.smtp} />;
}

function testEmailErrorOf(error: unknown): string {
  if (isProblem(error, problemTypes.smtpNotConfigured)) return "Email isn't set up yet. Save the settings above first.";
  if (isProblem(error, problemTypes.mailSendFailed)) {
    return "The test email could not be sent. Check the host, port, security and sign-in details, then try again.";
  }
  return problemMessage(error, "Sending the test email did not work. Try again.");
}

function MailSettingsForm({ saved }: { readonly saved: SmtpSettings | null }) {
  const id = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { run } = useRecentSignIn();
  const savedDraft = draftOf(saved);
  const [edited, setEdited] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const draft = edited ?? savedDraft;
  const dirty =
    edited !== null && fieldNames.some((name) => (name === "password" ? edited.password !== "" : edited[name] !== savedDraft[name]));

  const save = useMutation({
    mutationFn: (request: UpdateMailSettingsRequest) => run(() => api("updateMailSettings", { body: request })),
    onMutate: (): void => sendTest.reset(),
    onSuccess: (updated) => {
      queryClient.setQueryData(mailSettingsQueryKey, updated);
      setEdited(null);
      toast.show({ tone: "success", title: "Email settings saved" });
    },
  });

  const sendTest = useMutation({
    mutationFn: () => api("sendTestEmail"),
    onMutate: (): void => save.reset(),
    onSuccess: ({ sentTo }) => toast.show({ tone: "success", title: `Test email sent to ${sentTo}` }),
  });

  const field = (name: FieldName) => ({
    id: `${id}-${name}`,
    value: draft[name],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setEdited({ ...draft, [name]: event.target.value }),
    ...errorProp(errors[name]),
  });

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = parseDraft(draft);
    if ("errors" in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    save.mutate(result.request);
  };

  const discard = () => {
    setEdited(null);
    setErrors({});
    save.reset();
  };

  const saveFailed = save.isError && !isRecentSignInCancelled(save.error);

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      {saveFailed && (
        <Alert tone="danger">
          {isProblem(save.error, problemTypes.validationFailed)
            ? problemMessage(save.error, "These settings were refused. Check them and try again.")
            : problemMessage(save.error, "Saving did not work. Try again.")}
        </Alert>
      )}
      {saved === null && (
        <Alert tone="info" title="Email isn't set up">
          Until it is, invitations and re-link links aren't emailed: you copy them and send them yourself.
        </Alert>
      )}
      <Card title="SMTP server" padding="none" bodyClassName="px-5">
        <SettingsRow label="Host" htmlFor={`${id}-host`} description="The SMTP server's host name or IP address.">
          <Input autoCapitalize="none" spellCheck={false} placeholder="smtp.example.com" className="max-w-120" {...field("host")} />
        </SettingsRow>
        <SettingsRow label="Port" htmlFor={`${id}-port`} description="Usually 587 for STARTTLS and 465 for TLS.">
          <Input type="number" inputMode="numeric" step={1} min={1} max={65_535} className="w-48" {...field("port")} />
        </SettingsRow>
        <SettingsRow
          label="Security"
          htmlFor={`${id}-tlsMode`}
          description="How the connection is encrypted. None is allowed only for a server on this computer."
        >
          <Select
            id={`${id}-tlsMode`}
            className="w-64"
            options={tlsModeOptions}
            value={draft.tlsMode}
            onChange={(value) => setEdited({ ...draft, tlsMode: value })}
            {...errorProp(errors.tlsMode)}
          />
        </SettingsRow>
        <SettingsRow label="Username" htmlFor={`${id}-username`} description="Optional. Leave it empty for a server that needs no sign-in.">
          <Input autoComplete="off" autoCapitalize="none" spellCheck={false} className="max-w-120" {...field("username")} />
        </SettingsRow>
        <SettingsRow label="Password" htmlFor={`${id}-password`} description="Used with the username. It is never shown again once saved.">
          <PasswordInput
            autoComplete="new-password"
            className="max-w-120"
            {...(saved?.passwordSet === true ? { placeholder: "Saved — leave blank to keep" } : {})}
            {...field("password")}
          />
        </SettingsRow>
        <SettingsRow label="From address" htmlFor={`${id}-fromAddress`} description="The sender of every email NotUnreachable sends.">
          <Input type="email" autoComplete="off" placeholder="files@example.com" className="max-w-120" {...field("fromAddress")} />
        </SettingsRow>
      </Card>

      <Card title="Test email" subtitle="Sends an email to your own address with the saved settings.">
        <div className="flex flex-col gap-3">
          {sendTest.isError && <Alert tone="danger">{testEmailErrorOf(sendTest.error)}</Alert>}
          <div>
            <Button variant="secondary" loading={sendTest.isPending} onClick={() => sendTest.mutate()}>
              Send test email
            </Button>
          </div>
        </div>
      </Card>

      <div className="sticky bottom-0 z-sticky flex items-center justify-end gap-3 rounded-card border border-solid border-border bg-surface px-5 py-3">
        {dirty && <span className="mr-auto type-body-sm text-fg-2">You have unsaved changes</span>}
        <Button variant="secondary" disabled={!dirty || save.isPending} onClick={discard}>
          Discard changes
        </Button>
        <Button type="submit" disabled={!dirty} loading={save.isPending}>
          Save changes
        </Button>
      </div>
    </form>
  );
}
