import { uploadLimitsSchema, type UploadLimits } from "@not-unreachable/contracts";
import { Alert, Button, Card, Input, useToast } from "@not-unreachable/design-system";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type * as React from "react";
import { api } from "../api/index.ts";
import { SettingsRow } from "../layout/index.ts";
import { BYTES_PER_GB, errorProp, problemMessage } from "../lib/index.ts";

export const uploadLimitsQueryKey = ["admin", "settings", "limits"] as const;

type FieldKey =
  "maxFileGb" | "reservePercent" | "reserveGb" | "inProgressPerAccount" | "inProgressPerInstance" | "createdPerAccountPerHour";

interface FieldSpec {
  readonly key: FieldKey;
  readonly label: string;
  readonly description: string;
  readonly unit: string;
  /** The allowed range, in the field's own unit, for the hint and the error. */
  readonly range: string;
  /** Sizes are typed in GB, with decimals; the rest are whole numbers. */
  readonly decimal: boolean;
}

interface FieldGroup {
  readonly title: string;
  readonly fields: readonly FieldSpec[];
}

const counts = uploadLimitsSchema.shape;
const reserve = counts.diskReserve.shape;

function wholeRange(schema: { readonly minValue: number | null; readonly maxValue: number | null }): string {
  return `${schema.minValue ?? 0} to ${schema.maxValue ?? "any"}`;
}

const groups: readonly FieldGroup[] = [
  {
    title: "File size",
    fields: [
      {
        key: "maxFileGb",
        label: "Largest file",
        description: "The largest file one upload may hold. Larger ones are refused before any byte is sent.",
        unit: "GB",
        range: "more than 0",
        decimal: true,
      },
    ],
  },
  {
    title: "Disk reserve",
    fields: [
      {
        key: "reservePercent",
        label: "Free space to keep, share",
        description: "An upload is refused when it would leave less than this share of the disk free. It applies to the admin too.",
        unit: "%",
        range: wholeRange(reserve.percent),
        decimal: false,
      },
      {
        key: "reserveGb",
        label: "Free space to keep, amount",
        description: "An upload is refused when it would leave less than this much of the disk free.",
        unit: "GB",
        range: "0 or more",
        decimal: true,
      },
    ],
  },
  {
    title: "Uploads in progress",
    fields: [
      {
        key: "inProgressPerAccount",
        label: "Per account",
        description: "Unfinished uploads one account may have at once, paused ones included.",
        unit: "uploads",
        range: wholeRange(counts.inProgressPerAccount),
        decimal: false,
      },
      {
        key: "inProgressPerInstance",
        label: "On the whole instance",
        description: "Unfinished uploads all accounts together may have at once.",
        unit: "uploads",
        range: wholeRange(counts.inProgressPerInstance),
        decimal: false,
      },
      {
        key: "createdPerAccountPerHour",
        label: "New uploads per account per hour",
        description: "Uploads one account may start in an hour.",
        unit: "uploads",
        range: wholeRange(counts.createdPerAccountPerHour),
        decimal: false,
      },
    ],
  },
];

const allFields = groups.flatMap((group) => group.fields);

type Draft = Readonly<Record<FieldKey, string>>;

const gbText = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3, useGrouping: false });

function draftOf(limits: UploadLimits): Draft {
  return {
    maxFileGb: gbText.format(limits.maxFileBytes / BYTES_PER_GB),
    reservePercent: String(limits.diskReserve.percent),
    reserveGb: gbText.format(limits.diskReserve.bytes / BYTES_PER_GB),
    inProgressPerAccount: String(limits.inProgressPerAccount),
    inProgressPerInstance: String(limits.inProgressPerInstance),
    createdPerAccountPerHour: String(limits.createdPerAccountPerHour),
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return allFields.every((field) => a[field.key] === b[field.key]);
}

/** Which field each contract path is typed in. */
const fieldOfPath: Readonly<Partial<Record<string, FieldKey>>> = {
  maxFileBytes: "maxFileGb",
  "diskReserve.percent": "reservePercent",
  "diskReserve.bytes": "reserveGb",
  inProgressPerAccount: "inProgressPerAccount",
  inProgressPerInstance: "inProgressPerInstance",
  createdPerAccountPerHour: "createdPerAccountPerHour",
};

/** The draft as UploadLimits, or the error of each field the contract refuses. */
function parseDraft(draft: Draft): { limits: UploadLimits } | { errors: Partial<Record<FieldKey, string>> } {
  const number = (key: FieldKey) => {
    const text = draft[key].trim().replace(",", ".");
    return text === "" ? Number.NaN : Number(text);
  };
  const bytes = (key: FieldKey) => Math.round(number(key) * BYTES_PER_GB);
  const parsed = uploadLimitsSchema.safeParse({
    maxFileBytes: bytes("maxFileGb"),
    diskReserve: { percent: number("reservePercent"), bytes: bytes("reserveGb") },
    inProgressPerAccount: number("inProgressPerAccount"),
    inProgressPerInstance: number("inProgressPerInstance"),
    createdPerAccountPerHour: number("createdPerAccountPerHour"),
  });
  if (parsed.success) return { limits: parsed.data };
  const errors: Partial<Record<FieldKey, string>> = {};
  for (const issue of parsed.error.issues) {
    const key = fieldOfPath[issue.path.join(".")];
    const field = allFields.find((candidate) => candidate.key === key);
    if (field !== undefined) {
      errors[field.key] = field.decimal ? `Enter a number of GB, ${field.range}.` : `Enter a whole number from ${field.range}.`;
    }
  }
  return { errors };
}

export function LimitsSettings() {
  const query = useQuery({ queryKey: uploadLimitsQueryKey, queryFn: ({ signal }) => api("getUploadLimits", { signal }) });

  if (query.isPending) return <p className="m-0 type-body-sm text-fg-3">Loading limits…</p>;
  if (query.isError) {
    return (
      <Alert
        tone="danger"
        title="Limits could not be loaded"
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
  return <LimitsForm saved={query.data} />;
}

function LimitsForm({ saved }: { readonly saved: UploadLimits }) {
  const idBase = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [edited, setEdited] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const savedDraft = draftOf(saved);
  const draft = edited ?? savedDraft;
  const dirty = edited !== null && !sameDraft(edited, savedDraft);

  const save = useMutation({
    mutationFn: (limits: UploadLimits) => api("updateUploadLimits", { body: limits }),
    onSuccess: (updated) => {
      queryClient.setQueryData(uploadLimitsQueryKey, updated);
      setEdited(null);
      toast.show({ tone: "success", title: "Limits saved" });
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
    save.mutate(result.limits);
  };

  const discard = () => {
    setEdited(null);
    setErrors({});
    save.reset();
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      {save.isError && <Alert tone="danger">{problemMessage(save.error, "Saving did not work. Try again.")}</Alert>}
      {groups.map((group) => (
        <Card key={group.title} title={group.title} padding="none" bodyClassName="px-5">
          {group.fields.map((field) => {
            const id = `${idBase}-${field.key}`;
            return (
              <SettingsRow key={field.key} label={field.label} htmlFor={id} description={field.description}>
                <Input
                  id={id}
                  type="number"
                  inputMode={field.decimal ? "decimal" : "numeric"}
                  step={field.decimal ? "any" : 1}
                  min={0}
                  className="w-48"
                  suffix={<span className="type-body-sm text-fg-3">{field.unit}</span>}
                  hint={`${field.range} ${field.unit}`}
                  value={draft[field.key]}
                  onChange={(event) => setEdited({ ...draft, [field.key]: event.target.value })}
                  {...errorProp(errors[field.key])}
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
