import {
  DEFAULT_SMB_PROTOCOL,
  problemTypes,
  RESOURCE_NAME_MAX_CHARACTERS,
  smbDomainSchema,
  smbEncrypts,
  smbHostSchema,
  smbPasswordSchema,
  smbProtocols,
  smbShareSchema,
  smbSubfolderSchema,
  smbUsernameSchema,
  type Resource,
  type ResourceChange,
  type ResourceCheck,
  type ResourceCheckRequest,
  type SmbProtocol,
} from "@not-unreachable/contracts";
import { Alert, Button, Icon, Input, PasswordInput, Select, Switch, useToast } from "@not-unreachable/design-system";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type * as React from "react";
import type { z } from "zod";
import { api } from "../api/index.ts";
import { errorProp, isProblem, problemMessage } from "../lib/index.ts";
import { resourcesQueryKey, saveMutationKey } from "./resource-keys.ts";
import { ResourceCheckAlert, shareRefusalOf, smbProtocolLabels, UNENCRYPTED_WARNING } from "./resource-wording.tsx";

type SmbResource = Extract<Resource, { kind: "smb" }>;
type SmbChange = Extract<ResourceChange, { kind: "smb" }>;
type SmbCheckRequest = Extract<ResourceCheckRequest, { kind: "smb" }>;

interface Draft {
  readonly name: string;
  readonly host: string;
  readonly share: string;
  readonly subfolder: string;
  readonly username: string;
  readonly password: string;
  readonly domain: string;
  readonly protocol: SmbProtocol;
  /** The Switch's own state; SMB 2.1 never encrypts, whatever it says (smbEncrypts). */
  readonly encrypt: boolean;
}

type Field = keyof Omit<Draft, "protocol" | "encrypt">;
type FormErrors = { [Key in Field]?: string | undefined };

/** The fields that make up the connection: changing one makes the last Test connection stale. */
const connectionFields: readonly (keyof Draft)[] = ["host", "share", "subfolder", "username", "password", "domain", "protocol", "encrypt"];

const protocolOptions = smbProtocols.map((protocol) => ({ value: protocol, label: smbProtocolLabels[protocol] }));

function isProtocol(value: string): value is SmbProtocol {
  return smbProtocols.some((protocol) => protocol === value);
}

/** The schema's message as a sentence, or undefined when the value is fine. */
function messageOf(schema: z.ZodType, value: string): string | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? undefined : `${parsed.error.issues[0]?.message ?? "Check this field"}.`;
}

/** The folder in the share as the server stores it: no slashes at either end. */
function folderOf(subfolder: string): string {
  return subfolder.trim().replace(/^\/+|\/+$/g, "");
}

/** The saved password goes only to the server it was saved for, so another server needs it again. */
function needsPassword(resource: SmbResource | null, draft: Draft): boolean {
  return resource === null || draft.host.trim() !== resource.host;
}

function connectionErrorsOf(draft: Draft, passwordRequired: boolean): FormErrors {
  const errors: FormErrors = {};
  if (draft.host.trim() === "") errors.host = "Enter the server's name or IP address.";
  else errors.host = messageOf(smbHostSchema, draft.host);
  if (draft.share.trim() === "") errors.share = "Enter the share's name.";
  else errors.share = messageOf(smbShareSchema, draft.share);
  errors.subfolder = messageOf(smbSubfolderSchema, draft.subfolder);
  if (draft.username.trim() === "") errors.username = "Enter the user name.";
  else errors.username = messageOf(smbUsernameSchema, draft.username);
  if (draft.password !== "") errors.password = messageOf(smbPasswordSchema, draft.password);
  else if (passwordRequired) errors.password = "Enter the password.";
  errors.domain = messageOf(smbDomainSchema, draft.domain);
  return errors;
}

function errorsOf(draft: Draft, passwordRequired: boolean): FormErrors {
  const name = draft.name.trim();
  const errors = connectionErrorsOf(draft, passwordRequired);
  if (name === "") errors.name = "Enter a name.";
  else if (name.length > RESOURCE_NAME_MAX_CHARACTERS) errors.name = `Use at most ${RESOURCE_NAME_MAX_CHARACTERS} characters.`;
  return errors;
}

function hasErrors(errors: FormErrors): boolean {
  return Object.values(errors).some((message) => message !== undefined);
}

/** The connection settings as Add resource and Test connection send them. */
function connectionOf(draft: Draft) {
  return {
    host: draft.host.trim(),
    share: draft.share.trim(),
    subfolder: folderOf(draft.subfolder),
    username: draft.username.trim(),
    domain: draft.domain.trim(),
    protocol: draft.protocol,
    encrypt: smbEncrypts(draft.protocol, draft.encrypt),
  };
}

/** Only the fields that changed; an empty password keeps the saved one. */
function changeOf(resource: SmbResource, draft: Draft): SmbChange {
  const change: { -readonly [Key in keyof SmbChange]: SmbChange[Key] } = { kind: "smb" };
  const name = draft.name.trim();
  const connection = connectionOf(draft);
  if (name !== resource.name) change.name = name;
  if (connection.host !== resource.host) change.host = connection.host;
  if (connection.share !== resource.share) change.share = connection.share;
  if (connection.subfolder !== resource.subfolder) change.subfolder = connection.subfolder;
  if (connection.username !== resource.username) change.username = connection.username;
  if (connection.domain !== resource.domain) change.domain = connection.domain;
  if (connection.protocol !== resource.protocol) change.protocol = connection.protocol;
  if (connection.encrypt !== smbEncrypts(resource.protocol, resource.encrypt)) change.encrypt = connection.encrypt;
  if (draft.password !== "") change.password = draft.password;
  return change;
}

export interface SmbShareFormProps {
  readonly formId: string;
  readonly resource: SmbResource | null;
  readonly onDone: () => void;
}

/** The SMB share form of the resource Drawer: connection settings, Test connection and Save. */
export function SmbShareForm({ formId, resource, onDone }: SmbShareFormProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>({
    name: resource?.name ?? "",
    host: resource?.host ?? "",
    share: resource?.share ?? "",
    subfolder: resource?.subfolder ?? "",
    username: resource?.username ?? "",
    password: "",
    domain: resource?.domain ?? "",
    protocol: resource?.protocol ?? DEFAULT_SMB_PROTOCOL,
    // A share saved on 2.1 has encryption off; it is on again if the admin picks a newer protocol.
    encrypt: resource === null || resource.protocol === "2.1" ? true : resource.encrypt,
  });
  const [errors, setErrors] = useState<FormErrors>({});
  /** The last "Test connection" result or refused save, for the settings it was about. */
  const [result, setResult] = useState<ResourceCheck | null>(null);

  const check = useMutation({
    mutationFn: (body: SmbCheckRequest) => api("checkResource", { body }),
    onMutate: () => setResult(null),
    onSuccess: setResult,
  });

  const save = useMutation({
    mutationKey: saveMutationKey,
    mutationFn: (values: Draft): Promise<Resource | null> => {
      if (resource === null) {
        return api("addResource", { body: { kind: "smb", name: values.name.trim(), ...connectionOf(values), password: values.password } });
      }
      const change = changeOf(resource, values);
      // Nothing changed: nothing to send.
      if (Object.keys(change).length === 1) return Promise.resolve(null);
      return api("changeResource", { params: { id: resource.id }, body: change });
    },
    onMutate: () => check.reset(),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: resourcesQueryKey });
      if (resource === null) toast.show({ tone: "success", title: "Share added" });
      else if (saved !== null) toast.show({ tone: "success", title: "Resource saved" });
      onDone();
    },
    onError: (error) => {
      const refusal = shareRefusalOf(error);
      if (refusal !== null) setResult(refusal);
      else if (isProblem(error, problemTypes.resourceNameTaken)) setErrors({ name: "Another resource already has this name." });
    },
  });

  const update = (change: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...change }));
    if (connectionFields.some((field) => field in change)) {
      setResult(null);
      check.reset();
    }
  };

  const testConnection = () => {
    const found = connectionErrorsOf(draft, needsPassword(resource, draft));
    setErrors({ ...found, name: errors.name });
    if (hasErrors(found)) return;
    const connection = connectionOf(draft);
    check.mutate(
      draft.password === "" && resource !== null
        ? { kind: "smb", ...connection, resourceId: resource.id }
        : { kind: "smb", ...connection, password: draft.password },
    );
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = errorsOf(draft, needsPassword(resource, draft));
    setErrors(found);
    if (hasErrors(found)) return;
    setResult(null);
    save.mutate(draft);
  };

  const field = (name: Field) => ({
    value: draft[name],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => update({ [name]: event.target.value }),
    ...errorProp(errors[name]),
  });

  const saveFailed = save.isError && shareRefusalOf(save.error) === null && !isProblem(save.error, problemTypes.resourceNameTaken);
  const canEncrypt = draft.protocol !== "2.1";
  const encrypted = smbEncrypts(draft.protocol, draft.encrypt);

  return (
    <div className="flex flex-col gap-5">
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
        {saveFailed && <Alert tone="danger">{problemMessage(save.error, "Saving did not work. Try again.")}</Alert>}
        <Input
          label="Name"
          hint="How the resource is shown in NotUnreachable."
          maxLength={RESOURCE_NAME_MAX_CHARACTERS}
          {...field("name")}
        />
        <Input
          label="Server"
          hint="The host name or IP address of the computer that has the share."
          placeholder="nas.local"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputClassName="type-mono"
          {...field("host")}
        />
        <Input
          label="Share"
          hint="The share's name on the server, without slashes."
          placeholder="files"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputClassName="type-mono"
          {...field("share")}
        />
        <Input
          label="Folder in share"
          hint="Optional. A folder inside the share, such as Photos/2026. Leave it empty for the share's top folder."
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputClassName="type-mono"
          {...field("subfolder")}
        />
        <Input label="Username" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} {...field("username")} />
        <PasswordInput
          label="Password"
          autoComplete="new-password"
          hint={
            resource === null
              ? "Kept encrypted. It is never shown again."
              : needsPassword(resource, draft)
                ? "Enter it again: the saved password is only sent to the server it was saved for."
                : resource.smbPasswordSet
                  ? "Leave empty to keep the saved password."
                  : "No password is saved yet."
          }
          {...field("password")}
        />
        <Input
          label="Domain"
          hint="Optional. Only for a server that asks for one, such as a Windows domain."
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          {...field("domain")}
        />
        <Select
          label="Protocol"
          hint="SMB 3.1.1 suits most servers. Pick an older one only if the server needs it."
          options={protocolOptions}
          value={draft.protocol}
          onChange={(value) => {
            if (isProtocol(value)) update({ protocol: value });
          }}
        />
        <Switch
          label="Encrypt traffic"
          description={canEncrypt ? "Files and passwords are encrypted on the way to the share." : "SMB 2.1 can't encrypt traffic."}
          checked={encrypted}
          disabled={!canEncrypt}
          onChange={(checked) => update({ encrypt: checked })}
        />
        {!encrypted && (
          <Alert tone="warning" title={UNENCRYPTED_WARNING}>
            Anyone on the network between this server and the share can read the files sent to it.
          </Alert>
        )}
        <div className="flex items-center gap-3">
          <Button variant="secondary" iconLeft={<Icon name="link" size={14} />} loading={check.isPending} onClick={testConnection}>
            Test connection
          </Button>
          <span className="type-body-sm text-fg-3">Signs in to the share without saving anything.</span>
        </div>
      </form>
      {check.isError && <Alert tone="danger">{problemMessage(check.error, "Testing the connection did not work. Try again.")}</Alert>}
      {result !== null && <ResourceCheckAlert result={result} />}
    </div>
  );
}
