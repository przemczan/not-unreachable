import {
  problemTypes,
  ssoIssuerSchema,
  ssoProviderKinds,
  SSO_PROVIDER_NAME_MAX_CHARACTERS,
  type AddSsoProviderRequest,
  type ChangeSsoProviderRequest,
  type SsoProvider,
  type SsoProviderKind,
} from "@not-unreachable/contracts";
import { Alert, Button, CopyField, Drawer, Input, PasswordInput, RadioGroup, Switch, useToast } from "@not-unreachable/design-system";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type * as React from "react";
import { api } from "../api/index.ts";
import { errorProp, isProblem, newId, providerKindLabels, ssoProblemMessage, ssoRedirectUri } from "../lib/index.ts";
import { isRecentSignInCancelled, useRecentSignIn } from "../session/index.ts";
import { SignInProviderHelp } from "./sign-in-provider-help.tsx";

export const ssoProvidersQueryKey = ["admin", "sso-providers"] as const;

const saveMutationKey = ["admin", "sso-providers", "save"] as const;

/** What the Drawer is open for: a new provider, or one provider to edit. */
export type ProviderDrawerState = { readonly mode: "add" } | { readonly mode: "edit"; readonly provider: SsoProvider } | null;

const kindOptions = ssoProviderKinds.map((kind) => ({ value: kind, label: providerKindLabels[kind] }));

function isKind(value: string): value is SsoProviderKind {
  return ssoProviderKinds.some((kind) => kind === value);
}

interface Draft {
  readonly kind: SsoProviderKind;
  readonly name: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly enabled: boolean;
}

interface FormErrors {
  name?: string;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
}

function errorsOf(draft: Draft, provider: SsoProvider | null): FormErrors {
  const errors: FormErrors = {};
  const name = draft.name.trim();
  if (name === "") errors.name = "Enter a name.";
  else if (name.length > SSO_PROVIDER_NAME_MAX_CHARACTERS) errors.name = `Use at most ${SSO_PROVIDER_NAME_MAX_CHARACTERS} characters.`;
  if (draft.kind === "oidc") {
    if (draft.issuer.trim() === "") errors.issuer = "Enter the issuer.";
    else if (!ssoIssuerSchema.safeParse(draft.issuer.trim()).success)
      errors.issuer = "Enter an https:// address without a query or fragment.";
  }
  if (draft.clientId.trim() === "") errors.clientId = "Enter the client ID.";
  if (draft.clientSecret.trim() === "") {
    if (provider === null) errors.clientSecret = "Enter the client secret.";
    // The server never sends a saved secret to another issuer.
    else if (provider.kind === "oidc" && draft.issuer.trim() !== provider.issuer)
      errors.clientSecret = "Enter the client secret again: the issuer changed.";
  }
  return errors;
}

function hasErrors(errors: FormErrors): boolean {
  return Object.values(errors).some((message) => message !== undefined);
}

/** A new provider's request, by its kind, with the id its redirect URI was shown with. */
function addRequestOf(id: string, draft: Draft): AddSsoProviderRequest {
  const fields = {
    id,
    name: draft.name.trim(),
    clientId: draft.clientId.trim(),
    clientSecret: draft.clientSecret.trim(),
    enabled: draft.enabled,
  };
  return draft.kind === "oidc" ? { kind: "oidc", issuer: draft.issuer.trim(), ...fields } : { kind: draft.kind, ...fields };
}

/** Only the fields that changed; an empty client secret keeps the saved one. */
function changeRequestOf(provider: SsoProvider, draft: Draft): ChangeSsoProviderRequest {
  const change: { -readonly [Key in keyof ChangeSsoProviderRequest]: ChangeSsoProviderRequest[Key] } = {};
  const name = draft.name.trim();
  const issuer = draft.issuer.trim();
  const clientId = draft.clientId.trim();
  const clientSecret = draft.clientSecret.trim();
  if (name !== provider.name) change.name = name;
  if (provider.kind === "oidc" && issuer !== provider.issuer) change.issuer = issuer;
  if (clientId !== provider.clientId) change.clientId = clientId;
  if (clientSecret !== "") change.clientSecret = clientSecret;
  if (draft.enabled !== provider.enabled) change.enabled = draft.enabled;
  return change;
}

export interface SignInProviderDrawerProps {
  readonly state: ProviderDrawerState;
  /** `PUBLIC_ORIGIN`, as the server reports it: every redirect URI is on it. */
  readonly publicOrigin: string;
  /** Called with the Drawer's next state: null to close it. */
  readonly onChange: (state: ProviderDrawerState) => void;
}

/**
 * Marks a field for 1Password, LastPass and Bitwarden to leave alone: the client ID and secret are
 * the provider's, never the admin's own sign-in, which they would otherwise fill in.
 */
const passwordManagersIgnore = { "data-1p-ignore": true, "data-lpignore": "true", "data-bwignore": true } as const;

/** The Drawer to add a sign-in provider or edit one. */
export function SignInProviderDrawer({ state, publicOrigin, onChange }: SignInProviderDrawerProps) {
  const formId = useId();
  const saving = useIsMutating({ mutationKey: saveMutationKey }) > 0;
  const editing = state?.mode === "edit" ? state.provider : null;
  const close = () => onChange(null);
  return (
    <Drawer
      open={state !== null}
      onClose={close}
      title={editing === null ? "Add provider" : "Edit provider"}
      description={editing === null ? "A service people can sign in with." : `${editing.name} · ${providerKindLabels[editing.kind]}`}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {editing === null ? "Add provider" : "Save changes"}
          </Button>
        </>
      }
    >
      {/* A fresh form each time the Drawer opens, so nothing typed for the last one stays. */}
      {state !== null && (
        <ProviderForm key={editing?.id ?? "new"} formId={formId} provider={editing} publicOrigin={publicOrigin} onDone={close} />
      )}
    </Drawer>
  );
}

interface ProviderFormProps {
  readonly formId: string;
  readonly provider: SsoProvider | null;
  readonly publicOrigin: string;
  readonly onDone: () => void;
}

function ProviderForm({ formId, provider, publicOrigin, onDone }: ProviderFormProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { run } = useRecentSignIn();
  const [draft, setDraft] = useState<Draft>({
    kind: provider?.kind ?? "google",
    name: provider?.name ?? providerKindLabels.google,
    issuer: provider?.kind === "oidc" ? provider.issuer : "",
    clientId: provider?.clientId ?? "",
    clientSecret: "",
    enabled: provider?.enabled ?? true,
  });
  const [errors, setErrors] = useState<FormErrors>({});
  // A new provider's id is made here, so its redirect URI can be registered at the provider before
  // it is added. A form closed unsaved drops it: nothing knows it yet.
  const [newProviderId] = useState(newId);

  const save = useMutation({
    mutationKey: saveMutationKey,
    mutationFn: (values: Draft): Promise<SsoProvider | null> => {
      if (provider === null) return run(() => api("addSsoProvider", { body: addRequestOf(newProviderId, values) }));
      const change = changeRequestOf(provider, values);
      // Nothing changed: nothing to send (the server wants at least one field).
      if (Object.keys(change).length === 0) return Promise.resolve(null);
      return run(() => api("changeSsoProvider", { params: { id: provider.id }, body: change }));
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ssoProvidersQueryKey });
      if (saved !== null) toast.show({ tone: "success", title: provider === null ? "Provider added" : "Provider saved" });
      onDone();
    },
    onError: (error) => {
      if (isProblem(error, problemTypes.ssoDiscoveryFailed)) setErrors({ issuer: ssoProblemMessage(error, "") });
      else if (isProblem(error, problemTypes.ssoIssuerTaken) && draft.kind === "oidc") setErrors({ issuer: ssoProblemMessage(error, "") });
    },
  });

  const update = (change: Partial<Draft>) => setDraft((current) => ({ ...current, ...change }));

  const changeKind = (value: string) => {
    if (!isKind(value)) return;
    // The name follows the kind until it is typed.
    const nameIsDefault = draft.name.trim() === "" || draft.name === providerKindLabels[draft.kind];
    update({ kind: value, ...(nameIsDefault ? { name: value === "oidc" ? "" : providerKindLabels[value] } : {}) });
    setErrors({});
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = errorsOf(draft, provider);
    setErrors(found);
    if (!hasErrors(found)) save.mutate(draft);
  };

  const fieldError =
    isProblem(save.error, problemTypes.ssoDiscoveryFailed) || (isProblem(save.error, problemTypes.ssoIssuerTaken) && draft.kind === "oidc");
  const saveFailed = save.isError && !isRecentSignInCancelled(save.error) && !fieldError;
  const issuerTaken = isProblem(save.error, problemTypes.ssoIssuerTaken);
  // Linked sign-ins match on the issuer (the server refuses the change too).
  const issuerLocked = (provider?.linkedSignIns ?? 0) > 0;

  return (
    <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
      {saveFailed && (
        <Alert tone="danger">
          {issuerTaken
            ? `There is a ${providerKindLabels[draft.kind]} provider already.`
            : ssoProblemMessage(save.error, "Saving did not work. Try again.")}
        </Alert>
      )}
      {provider === null && <RadioGroup label="Kind" options={kindOptions} value={draft.kind} onChange={changeKind} />}
      {/* Open while adding, when the admin is setting the provider up; folded away when editing. */}
      <SignInProviderHelp kind={draft.kind} publicOrigin={publicOrigin} defaultOpen={provider === null} />
      <div className="flex flex-col gap-1.5">
        <CopyField label="Redirect URI" value={provider?.redirectUri ?? ssoRedirectUri(publicOrigin, newProviderId)} />
        <p className="m-0 type-caption text-fg-3">Register this address at the provider as the redirect or callback URL.</p>
      </div>
      <Input
        label="Name"
        hint="Shown on the sign-in page, as in Continue with Google."
        maxLength={SSO_PROVIDER_NAME_MAX_CHARACTERS}
        value={draft.name}
        onChange={(event) => update({ name: event.target.value })}
        {...errorProp(errors.name)}
      />
      {draft.kind === "oidc" && (
        <Input
          label="Issuer"
          hint={
            issuerLocked
              ? "Accounts sign in with this provider, so its issuer can't change."
              : "The provider's https:// address, as its documentation gives it."
          }
          disabled={issuerLocked}
          placeholder="https://login.example.com"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputClassName="type-mono"
          value={draft.issuer}
          onChange={(event) => update({ issuer: event.target.value })}
          {...errorProp(errors.issuer)}
        />
      )}
      <Input
        label="Client ID"
        autoComplete="off"
        {...passwordManagersIgnore}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        inputClassName="type-mono"
        value={draft.clientId}
        onChange={(event) => update({ clientId: event.target.value })}
        {...errorProp(errors.clientId)}
      />
      <PasswordInput
        label="Client secret"
        // Browsers ignore "off" on a password field and fill the saved sign-in; "new-password" they don't.
        autoComplete="new-password"
        {...passwordManagersIgnore}
        hint={
          provider === null
            ? "Kept encrypted. It is never shown again."
            : provider.clientSecretSet
              ? "A secret is saved. Leave this empty to keep it."
              : "No secret is saved yet."
        }
        {...(provider === null ? {} : { placeholder: "Leave empty to keep the current one" })}
        value={draft.clientSecret}
        onChange={(event) => update({ clientSecret: event.target.value })}
        {...errorProp(errors.clientSecret)}
      />
      <Switch
        label="On"
        description="People can sign in with it and link it in their settings."
        checked={draft.enabled}
        onChange={(checked) => update({ enabled: checked })}
      />
    </form>
  );
}
