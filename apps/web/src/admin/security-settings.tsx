import { securitySettingsSchema, type SecuritySettings as Settings } from "@not-unreachable/contracts";
import { Alert, Button, Card, Input, useToast } from "@not-unreachable/design-system";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type * as React from "react";
import type { z } from "zod";
import { api } from "../api/index.ts";
import { SettingsRow } from "../layout/index.ts";
import { errorProp, problemMessage } from "../lib/index.ts";
import { isRecentSignInCancelled, useRecentSignIn } from "../session/index.ts";

const securitySettingsQueryKey = ["admin", "settings", "security"] as const;

const timeouts = securitySettingsSchema.shape.sessionTimeouts.shape;
const limits = securitySettingsSchema.shape.signInLimits.shape;

interface FieldSpec {
  /** The setting's path in SecuritySettings, as zod reports it in an issue. */
  readonly path: string;
  readonly label: string;
  readonly description: string;
  readonly unit: string;
  /** Its contract schema, for the allowed range. */
  readonly schema: z.ZodNumber;
  readonly read: (settings: Settings) => number;
}

interface FieldGroup {
  readonly title: string;
  readonly fields: readonly FieldSpec[];
}

const groups: readonly FieldGroup[] = [
  {
    title: "Session timeouts",
    fields: [
      {
        path: "sessionTimeouts.admin.idleMinutes",
        label: "Admin idle timeout",
        description: "The admin is signed out after this long without activity.",
        unit: "minutes",
        schema: timeouts.admin.shape.idleMinutes,
        read: (settings) => settings.sessionTimeouts.admin.idleMinutes,
      },
      {
        path: "sessionTimeouts.admin.absoluteHours",
        label: "Admin session length",
        description: "The admin is signed out this long after signing in, whatever the activity.",
        unit: "hours",
        schema: timeouts.admin.shape.absoluteHours,
        read: (settings) => settings.sessionTimeouts.admin.absoluteHours,
      },
      {
        path: "sessionTimeouts.user.idleMinutes",
        label: "User idle timeout",
        description: "A user is signed out after this long without activity.",
        unit: "minutes",
        schema: timeouts.user.shape.idleMinutes,
        read: (settings) => settings.sessionTimeouts.user.idleMinutes,
      },
      {
        path: "sessionTimeouts.user.absoluteHours",
        label: "User session length",
        description: "A user is signed out this long after signing in, whatever the activity.",
        unit: "hours",
        schema: timeouts.user.shape.absoluteHours,
        read: (settings) => settings.sessionTimeouts.user.absoluteHours,
      },
    ],
  },
  {
    title: "Sign-in limits",
    fields: [
      {
        path: "signInLimits.perIpPerMinute",
        label: "Attempts per IP per minute",
        description: "Sign-in attempts allowed from one IP address (IPv6 by /64) in a minute.",
        unit: "attempts",
        schema: limits.perIpPerMinute,
        read: (settings) => settings.signInLimits.perIpPerMinute,
      },
      {
        path: "signInLimits.perIpPerHour",
        label: "Attempts per IP per hour",
        description: "Sign-in attempts allowed from one IP address (IPv6 by /64) in an hour.",
        unit: "attempts",
        schema: limits.perIpPerHour,
        read: (settings) => settings.signInLimits.perIpPerHour,
      },
      {
        path: "signInLimits.delayAfterFailures",
        label: "Delay after failures",
        description: "Failures from one IP for one account before each further attempt is delayed, from 1 up to 60 seconds.",
        unit: "failures",
        schema: limits.delayAfterFailures,
        read: (settings) => settings.signInLimits.delayAfterFailures,
      },
      {
        path: "signInLimits.lockAfterFailures",
        label: "Lock after failures",
        description: "Failures for one account in an hour, from any IP, that lock the account.",
        unit: "failures",
        schema: limits.lockAfterFailures,
        read: (settings) => settings.signInLimits.lockAfterFailures,
      },
      {
        path: "signInLimits.lockMinutes",
        label: "Lock duration",
        description: "How long a locked account stays locked.",
        unit: "minutes",
        schema: limits.lockMinutes,
        read: (settings) => settings.signInLimits.lockMinutes,
      },
    ],
  },
  {
    title: "Audit log",
    fields: [
      {
        path: "auditRetentionDays",
        label: "Retention",
        description: "Events older than this are deleted.",
        unit: "days",
        schema: securitySettingsSchema.shape.auditRetentionDays,
        read: (settings) => settings.auditRetentionDays,
      },
    ],
  },
];

const allFields = groups.flatMap((group) => group.fields);

/** The form's values, as typed: by field path. */
type Draft = Readonly<Record<string, string>>;

function draftOf(settings: Settings): Draft {
  return Object.fromEntries(allFields.map((field) => [field.path, String(field.read(settings))]));
}

function sameDraft(a: Draft, b: Draft): boolean {
  return allFields.every((field) => a[field.path] === b[field.path]);
}

/** The draft as SecuritySettings, or the error of each field the contract refuses. */
function parseDraft(draft: Draft): { settings: Settings } | { errors: Record<string, string> } {
  const number = (path: string) => {
    const text = (draft[path] ?? "").trim();
    return text === "" ? Number.NaN : Number(text);
  };
  const candidate = {
    sessionTimeouts: {
      admin: { idleMinutes: number("sessionTimeouts.admin.idleMinutes"), absoluteHours: number("sessionTimeouts.admin.absoluteHours") },
      user: { idleMinutes: number("sessionTimeouts.user.idleMinutes"), absoluteHours: number("sessionTimeouts.user.absoluteHours") },
    },
    signInLimits: {
      perIpPerMinute: number("signInLimits.perIpPerMinute"),
      perIpPerHour: number("signInLimits.perIpPerHour"),
      delayAfterFailures: number("signInLimits.delayAfterFailures"),
      lockAfterFailures: number("signInLimits.lockAfterFailures"),
      lockMinutes: number("signInLimits.lockMinutes"),
    },
    auditRetentionDays: number("auditRetentionDays"),
  };
  const parsed = securitySettingsSchema.safeParse(candidate);
  if (parsed.success) return { settings: parsed.data };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const field = allFields.find((candidateField) => candidateField.path === issue.path.join("."));
    if (field !== undefined) errors[field.path] = `Enter a whole number from ${rangeOf(field)}.`;
  }
  return { errors };
}

function rangeOf(field: FieldSpec): string {
  return `${field.schema.minValue ?? 0} to ${field.schema.maxValue ?? "any"}`;
}

export function SecuritySettings() {
  const query = useQuery({ queryKey: securitySettingsQueryKey, queryFn: ({ signal }) => api("getSecuritySettings", { signal }) });

  if (query.isPending) return <p className="m-0 type-body-sm text-fg-3">Loading security settings…</p>;
  if (query.isError) {
    return (
      <Alert
        tone="danger"
        title="Security settings could not be loaded"
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
  return <SecuritySettingsForm saved={query.data} />;
}

function SecuritySettingsForm({ saved }: { readonly saved: Settings }) {
  const idBase = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { run } = useRecentSignIn();
  const [edited, setEdited] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const savedDraft = draftOf(saved);
  const draft = edited ?? savedDraft;
  const dirty = edited !== null && !sameDraft(edited, savedDraft);

  const save = useMutation({
    mutationFn: (settings: Settings) => run(() => api("updateSecuritySettings", { body: settings })),
    onSuccess: (updated) => {
      queryClient.setQueryData(securitySettingsQueryKey, updated);
      setEdited(null);
      toast.show({ tone: "success", title: "Security settings saved" });
    },
  });

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = parseDraft(draft);
    if ("errors" in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    save.mutate(result.settings);
  };

  const discard = () => {
    setEdited(null);
    setErrors({});
    save.reset();
  };

  const saveFailed = save.isError && !isRecentSignInCancelled(save.error);

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      {saveFailed && <Alert tone="danger">{problemMessage(save.error, "Saving did not work. Try again.")}</Alert>}
      {groups.map((group) => (
        <Card key={group.title} title={group.title} padding="none" bodyClassName="px-5">
          {group.fields.map((field) => {
            const id = `${idBase}-${field.path}`;
            return (
              <SettingsRow key={field.path} label={field.label} htmlFor={id} description={field.description}>
                <Input
                  id={id}
                  type="number"
                  inputMode="numeric"
                  step={1}
                  min={field.schema.minValue ?? undefined}
                  max={field.schema.maxValue ?? undefined}
                  className="w-48"
                  suffix={<span className="type-body-sm text-fg-3">{field.unit}</span>}
                  hint={`${rangeOf(field)} ${field.unit}`}
                  value={draft[field.path] ?? ""}
                  onChange={(event) => setEdited({ ...draft, [field.path]: event.target.value })}
                  {...errorProp(errors[field.path])}
                />
              </SettingsRow>
            );
          })}
        </Card>
      ))}
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
