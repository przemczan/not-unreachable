import { RECOVERY_CODE_COUNT, problemTypes, type Passkey, type SecondFactor, type TotpEnrolment } from "@not-unreachable/contracts";
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  useToast,
  type DataTableColumn,
  type MenuItem,
} from "@not-unreachable/design-system";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api } from "../api/index.ts";
import { formatDateTime, formatRelative, isProblem, problemMessage } from "../lib/index.ts";
import {
  AuthenticatorSetup,
  PasskeyFailureAlert,
  PasskeyNameForm,
  PasskeysUnsupportedAlert,
  RecoveryCodesPanel,
  createPasskey,
  isPasskeyCeremonyError,
  passkeysQueryKey,
  passkeysSupported,
} from "../second-factors/index.ts";
import { isRecentSignInCancelled, useRecentSignIn, useSignedInSession } from "../session/index.ts";

const secondFactorsQueryKey = ["settings", "second-factors"] as const;

const lastFactorMessage = "Your last authenticator app can't be removed. Add another one first.";
const lastPasskeyMessage = "Your last passkey can't be removed. Add another passkey or an authenticator app first.";

/** A failure worth an Alert: not the person cancelling "Confirm it's you". */
function failureOf(error: Error | null): Error | null {
  return error === null || isRecentSignInCancelled(error) ? null : error;
}

/** Settings → Two-step sign-in: the admin's authenticator apps, passkeys and recovery codes. */
export function TwoStepSignInSettings() {
  const query = useQuery({ queryKey: secondFactorsQueryKey, queryFn: ({ signal }) => api("getSecondFactors", { signal }) });

  if (query.isPending) return <p className="m-0 type-body-sm text-fg-3">Loading two-step sign-in…</p>;
  if (query.isError) {
    return (
      <Alert
        tone="danger"
        title="Two-step sign-in could not be loaded"
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
  return (
    <div className="flex flex-col gap-4">
      <AuthenticatorApps factors={query.data.factors} />
      <Passkeys factors={query.data.factors} />
      <RecoveryCodes status={query.data.recoveryCodes} />
    </div>
  );
}

function AuthenticatorApps({ factors }: { readonly factors: readonly SecondFactor[] }) {
  const formId = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { run } = useRecentSignIn();
  const [removing, setRemoving] = useState<SecondFactor | null>(null);
  const [enrolment, setEnrolment] = useState<TotpEnrolment | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  // The server refuses removing the account's last factor, whatever its kind.
  const onlyOne = factors.length <= 1;
  const apps = factors.filter((factor) => factor.kind === "totp");

  const refresh = () => void queryClient.invalidateQueries({ queryKey: secondFactorsQueryKey });

  const start = useMutation({
    mutationFn: () => run(() => api("addTotp")),
    onMutate: (): void => remove.reset(),
    onSuccess: (started) => {
      setCodeError(null);
      setEnrolment(started);
    },
  });

  const confirm = useMutation({
    mutationFn: ({ id, code }: { readonly id: string; readonly code: string }) =>
      run(() => api("confirmTotp", { params: { id }, body: { code } })),
    onMutate: (): void => setCodeError(null),
    onSuccess: () => {
      setEnrolment(null);
      refresh();
      toast.show({ tone: "success", title: "Authenticator app added" });
    },
    onError: (error) => {
      if (isRecentSignInCancelled(error)) return;
      setCodeError(
        isProblem(error, problemTypes.secondFactorFailed)
          ? "The code is not right, or the setup took too long. Check the code in your app and try again."
          : problemMessage(error, "Adding the app did not work. Try again."),
      );
    },
  });

  const remove = useMutation({
    mutationFn: (factor: SecondFactor) => run(() => api("removeTotp", { params: { id: factor.id } })),
    onMutate: (): void => start.reset(),
    onSuccess: () => toast.show({ tone: "success", title: "Authenticator app removed" }),
    onSettled: () => {
      setRemoving(null);
      refresh();
    },
  });

  const failure = failureOf(start.error) ?? failureOf(remove.error);

  const columns: DataTableColumn<SecondFactor>[] = [
    { key: "kind", header: "App", render: () => "Authenticator app" },
    { key: "createdAt", header: "Added", render: (factor) => <time dateTime={factor.createdAt}>{formatDateTime(factor.createdAt)}</time> },
    {
      key: "lastUsedAt",
      header: "Last used",
      render: (factor) =>
        factor.lastUsedAt === null ? (
          "Never"
        ) : (
          <time dateTime={factor.lastUsedAt} title={formatDateTime(factor.lastUsedAt)}>
            {formatRelative(factor.lastUsedAt)}
          </time>
        ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      render: (factor) => (
        <Button variant="danger-ghost" size="sm" disabled={onlyOne} onClick={() => setRemoving(factor)}>
          Remove
        </Button>
      ),
    },
  ];

  return (
    <>
      {failure !== null && (
        <Alert tone="danger">
          {isProblem(failure, problemTypes.lastSecondFactor) ? lastFactorMessage : problemMessage(failure, "That did not work. Try again.")}
        </Alert>
      )}
      <Card
        title="Authenticator apps"
        subtitle="Each sign-in asks for a code from one of these apps after your password."
        padding="none"
        actions={
          <Button variant="secondary" loading={start.isPending} onClick={() => start.mutate()}>
            Add authenticator app
          </Button>
        }
        footer={onlyOne && apps.length === 1 ? lastFactorMessage : undefined}
      >
        <DataTable
          caption="Your authenticator apps"
          columns={columns}
          rows={apps}
          empty={<EmptyState compact title="No authenticator apps" description="Add one to sign in with a code from your phone." />}
        />
      </Card>

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        tone="danger"
        title="Remove this authenticator app?"
        description="Its codes stop working for signing in. This can't be undone."
        actions={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => {
                if (removing !== null) remove.mutate(removing);
              }}
            >
              Remove app
            </Button>
          </>
        }
      />
      <Dialog
        open={enrolment !== null}
        onClose={() => setEnrolment(null)}
        title="Add authenticator app"
        actions={
          <>
            <Button variant="secondary" onClick={() => setEnrolment(null)}>
              Cancel
            </Button>
            <Button type="submit" form={formId} loading={confirm.isPending}>
              Add app
            </Button>
          </>
        }
      >
        {enrolment !== null && (
          <AuthenticatorSetup
            key={enrolment.id}
            id={formId}
            enrolment={enrolment}
            error={codeError}
            onSubmit={(code) => confirm.mutate({ id: enrolment.id, code })}
          />
        )}
      </Dialog>
    </>
  );
}

/** The admin's passkeys: a second factor in place of a code, and a way to sign in without the password. */
function Passkeys({ factors }: { readonly factors: readonly SecondFactor[] }) {
  const addFormId = useId();
  const renameFormId = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { run } = useRecentSignIn();
  const { account } = useSignedInSession();
  const query = useQuery({ queryKey: passkeysQueryKey, queryFn: ({ signal }) => api("listPasskeys", { signal }) });
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<Passkey | null>(null);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const supported = passkeysSupported();
  const onlyOne = factors.length <= 1;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: passkeysQueryKey });
    void queryClient.invalidateQueries({ queryKey: secondFactorsQueryKey });
  };

  const add = useMutation({
    mutationFn: async (name: string) => {
      const options = await run(() => api("startPasskeyRegistration"));
      const response = await createPasskey(options);
      return run(() => api("addPasskey", { body: { name, response } }));
    },
    onMutate: (): void => remove.reset(),
    onSuccess: (added) => {
      setAdding(false);
      refresh();
      if (added.recoveryCodes === null) {
        toast.show({ tone: "success", title: "Passkey added" });
      } else {
        setSaved(false);
        setCodes(added.recoveryCodes);
      }
    },
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { readonly id: string; readonly name: string }) => api("renamePasskey", { params: { id }, body: { name } }),
    onSuccess: () => {
      setRenaming(null);
      refresh();
      toast.show({ tone: "success", title: "Passkey renamed" });
    },
  });

  const remove = useMutation({
    mutationFn: (passkey: Passkey) => run(() => api("removePasskey", { params: { id: passkey.id } })),
    onMutate: (): void => add.reset(),
    onSuccess: () => toast.show({ tone: "success", title: "Passkey removed" }),
    onSettled: () => {
      setRemoving(null);
      refresh();
    },
  });

  const removeFailure = failureOf(remove.error);
  const addFailure = failureOf(add.error);
  const passkeys = query.data?.passkeys ?? [];

  const actionsOf = (passkey: Passkey): MenuItem[] => [
    {
      label: "Rename",
      icon: <Icon name="pencil" size={14} />,
      onSelect: () => {
        rename.reset();
        setRenaming(passkey);
      },
    },
    { divider: true },
    {
      label: "Remove",
      icon: <Icon name="trash-2" size={14} />,
      danger: true,
      disabled: onlyOne,
      onSelect: () => {
        remove.reset();
        setRemoving(passkey);
      },
    },
  ];

  const columns: DataTableColumn<Passkey>[] = [
    {
      key: "name",
      header: "Name",
      wrap: true,
      render: (passkey) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="font-medium">{passkey.name}</span>
          {passkey.synced && <Badge tone="info">Synced</Badge>}
        </span>
      ),
    },
    {
      key: "createdAt",
      header: "Added",
      render: (passkey) => <time dateTime={passkey.createdAt}>{formatDateTime(passkey.createdAt)}</time>,
    },
    {
      key: "lastUsedAt",
      header: "Last used",
      render: (passkey) =>
        passkey.lastUsedAt === null ? (
          "Never"
        ) : (
          <time dateTime={passkey.lastUsedAt} title={formatDateTime(passkey.lastUsedAt)}>
            {formatRelative(passkey.lastUsedAt)}
          </time>
        ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      render: (passkey) => (
        <Menu
          width={200}
          trigger={
            <IconButton label={`Actions for the passkey ${passkey.name}`} size="sm" icon={<Icon name="more-horizontal" size={16} />} />
          }
          items={actionsOf(passkey)}
        />
      ),
    },
  ];

  return (
    <>
      {removeFailure !== null && (
        <Alert tone="danger">
          {isProblem(removeFailure, problemTypes.lastSecondFactor)
            ? lastPasskeyMessage
            : problemMessage(removeFailure, "Removing the passkey did not work. Try again.")}
        </Alert>
      )}
      <Card
        title="Passkeys"
        subtitle="Sign in with your phone, computer or security key, in place of a code or of your password."
        padding="none"
        actions={
          <Button
            variant="secondary"
            iconLeft={<Icon name="key-round" size={16} />}
            disabled={!supported}
            onClick={() => {
              add.reset();
              setAdding(true);
            }}
          >
            Add passkey
          </Button>
        }
        footer={onlyOne && passkeys.length === 1 && factors.length === 1 ? lastPasskeyMessage : undefined}
      >
        {!supported && (
          <div className="p-4">
            <PasskeysUnsupportedAlert />
          </div>
        )}
        {query.isPending ? (
          <p className="m-0 p-5 type-body-sm text-fg-3">Loading passkeys…</p>
        ) : query.isError ? (
          <div className="p-5">
            <Alert
              tone="danger"
              title="Passkeys could not be loaded"
              action={
                <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
                  Try again
                </Button>
              }
            >
              {problemMessage(query.error, "Reload the page to try again.")}
            </Alert>
          </div>
        ) : (
          <DataTable
            caption="Your passkeys"
            columns={columns}
            rows={passkeys}
            empty={<EmptyState compact title="No passkeys" description="Add one to sign in with your phone, computer or security key." />}
          />
        )}
      </Card>

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add passkey"
        description="Name it, then follow your browser's steps to make the passkey."
        actions={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" form={addFormId} loading={add.isPending}>
              Add passkey
            </Button>
          </>
        }
      >
        {adding && (
          <div className="flex flex-col gap-3">
            <PasskeyFailureAlert error={add.error} />
            {addFailure !== null && !isPasskeyCeremonyError(addFailure) && (
              <Alert tone="danger">{problemMessage(addFailure, "Adding the passkey did not work. Try again.")}</Alert>
            )}
            <PasskeyNameForm id={addFormId} loading={add.isPending} onSubmit={(name) => add.mutate(name)} />
          </div>
        )}
      </Dialog>
      <Dialog
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename passkey"
        actions={
          <>
            <Button variant="secondary" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button type="submit" form={renameFormId} loading={rename.isPending}>
              Rename passkey
            </Button>
          </>
        }
      >
        {renaming !== null && (
          <div className="flex flex-col gap-3">
            {rename.isError && <Alert tone="danger">{problemMessage(rename.error, "Renaming the passkey did not work. Try again.")}</Alert>}
            <PasskeyNameForm
              key={renaming.id}
              id={renameFormId}
              initialName={renaming.name}
              loading={rename.isPending}
              onSubmit={(name) => rename.mutate({ id: renaming.id, name })}
            />
          </div>
        )}
      </Dialog>
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        tone="danger"
        title="Remove this passkey?"
        description={`${removing?.name ?? "The passkey"} no longer signs you in. This can't be undone.`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => {
                if (removing !== null) remove.mutate(removing);
              }}
            >
              Remove passkey
            </Button>
          </>
        }
      />
      <Dialog
        open={codes !== null}
        title="Save your recovery codes"
        actions={
          <Button
            disabled={!saved}
            onClick={() => {
              setCodes(null);
              toast.show({ tone: "success", title: "Passkey added" });
            }}
          >
            Done
          </Button>
        }
      >
        {codes !== null && <RecoveryCodesPanel codes={codes} username={account.username} saved={saved} onSavedChange={setSaved} />}
      </Dialog>
    </>
  );
}

interface RecoveryCodesStatus {
  readonly remaining: number;
  readonly createdAt: string;
}

function RecoveryCodes({ status }: { readonly status: RecoveryCodesStatus | null }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { run } = useRecentSignIn();
  const { account } = useSignedInSession();
  const [confirming, setConfirming] = useState(false);
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const [saved, setSaved] = useState(false);

  const regenerate = useMutation({
    mutationFn: () => run(() => api("regenerateRecoveryCodes")),
    onSuccess: (answer) => {
      setSaved(false);
      setCodes(answer.recoveryCodes);
      void queryClient.invalidateQueries({ queryKey: secondFactorsQueryKey });
    },
    onSettled: () => setConfirming(false),
  });

  const done = () => {
    setCodes(null);
    toast.show({ tone: "success", title: "Recovery codes regenerated", description: "Your earlier codes no longer work." });
  };

  const failure = failureOf(regenerate.error);
  const remaining = status?.remaining ?? 0;

  return (
    <>
      <Card
        title="Recovery codes"
        subtitle="Each one signs you in once if you lose your authenticator app."
        actions={
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            Regenerate recovery codes
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {failure !== null && <Alert tone="danger">{problemMessage(failure, "Regenerating the codes did not work. Try again.")}</Alert>}
          {status === null ? (
            <p className="m-0 type-body-sm text-fg-2">You have no recovery codes yet.</p>
          ) : (
            <p className="m-0 flex flex-wrap items-center gap-2 type-body-sm text-fg-2">
              <Badge tone={remaining <= 2 ? "warning" : "neutral"}>
                {remaining} / {RECOVERY_CODE_COUNT} left
              </Badge>
              <span>
                Made <time dateTime={status.createdAt}>{formatDateTime(status.createdAt)}</time>.
              </span>
            </p>
          )}
        </div>
      </Card>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Regenerate recovery codes?"
        description="Your current codes stop working at once. You see the new ones only once, so be ready to save them."
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button loading={regenerate.isPending} onClick={() => regenerate.mutate()}>
              Regenerate codes
            </Button>
          </>
        }
      />
      <Dialog
        open={codes !== null}
        title="Save your new recovery codes"
        actions={
          <Button disabled={!saved} onClick={done}>
            Done
          </Button>
        }
      >
        {codes !== null && <RecoveryCodesPanel codes={codes} username={account.username} saved={saved} onSavedChange={setSaved} />}
      </Dialog>
    </>
  );
}
