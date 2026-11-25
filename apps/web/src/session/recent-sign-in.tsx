import { TOTP_CODE_DIGITS, problemTypes, type SessionConfirmation } from "@not-unreachable/contracts";
import { Alert, Button, CodeInput, Dialog, PasswordInput, SegmentedControl } from "@not-unreachable/design-system";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, use, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { ApiError, api } from "../api/index.ts";
import { isProblem, problemMessage } from "../lib/index.ts";
import { PasskeyFailureAlert, isPasskeyCeremonyError, signWithPasskey, useCanConfirmWithPasskey } from "../second-factors/index.ts";
import { sessionQueryKey, useSession } from "./session.tsx";

/** The person closed "Confirm it's you": the action is dropped, and nothing needs to be shown. */
export class RecentSignInCancelled extends Error {
  constructor() {
    super("The recent sign-in was not confirmed.");
    this.name = "RecentSignInCancelled";
  }
}

export function isRecentSignInCancelled(error: unknown): error is RecentSignInCancelled {
  return error instanceof RecentSignInCancelled;
}

export interface RecentSignIn {
  /**
   * Runs an action that may need a recent sign-in. When the server answers
   * `recent-sign-in-required`, it asks for the password or an authenticator code, renews the sign-in and runs the action
   * once more; it rejects with RecentSignInCancelled if the person cancels.
   */
  run: <T>(action: () => Promise<T>) => Promise<T>;
}

const RecentSignInContext = createContext<RecentSignIn | null>(null);

export function useRecentSignIn(): RecentSignIn {
  const context = use(RecentSignInContext);
  if (context === null) throw new Error("useRecentSignIn() needs a <RecentSignInProvider> above it.");
  return context;
}

interface PendingConfirmation {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

/** Holds the one "Confirm it's you" Dialog every page's actions share. */
export function RecentSignInProvider({ children }: { readonly children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  // Each confirmation gets a fresh dialog, so nothing typed or shown for the last one stays.
  const [round, setRound] = useState(0);
  const pending = useRef<PendingConfirmation | null>(null);

  // Actions that fail together wait for the same confirmation.
  const confirm = useCallback((): Promise<void> => {
    if (pending.current === null) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      pending.current = { promise, resolve, reject };
      setRound((previous) => previous + 1);
      setOpen(true);
    }
    return pending.current.promise;
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    const current = pending.current;
    pending.current = null;
    setOpen(false);
    if (confirmed) current?.resolve();
    else current?.reject(new RecentSignInCancelled());
  }, []);

  // The session ended while asking (it timed out, or was signed out elsewhere): the pages send the
  // visitor to sign in, so the action is dropped rather than left asking over the sign-in page.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!open) return undefined;
    return queryClient.getQueryCache().subscribe(() => {
      if (queryClient.getQueryData(sessionQueryKey) === null) settle(false);
    });
  }, [open, queryClient, settle]);

  const value = useMemo<RecentSignIn>(
    () => ({
      run: async (action) => {
        try {
          return await action();
        } catch (error) {
          if (!isProblem(error, problemTypes.recentSignInRequired)) throw error;
        }
        await confirm();
        return action();
      },
    }),
    [confirm],
  );

  return (
    <RecentSignInContext value={value}>
      {children}
      <RecentSignInDialog key={round} open={open} onConfirmed={() => settle(true)} onCancel={() => settle(false)} />
    </RecentSignInContext>
  );
}

interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onConfirmed: () => void;
  readonly onCancel: () => void;
}

/** The admin confirms with the password or a code; a user has neither, so signs in again. */
function RecentSignInDialog(props: ConfirmDialogProps) {
  const { data: session } = useSession();
  return session?.account.role === "user" ? <SignInAgainDialog {...props} /> : <ConfirmDialog {...props} />;
}

/**
 * Signs out and loads /sign-in afresh, where the user signs in with their provider again: a full
 * page load drops everything the account loaded.
 */
function SignInAgainDialog({ open, onCancel }: ConfirmDialogProps) {
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);

  const signInAgain = async () => {
    setSigningOut(true);
    setFailed(false);
    try {
      await api("signOut");
    } catch (error) {
      // 401: the session had already ended, which is what signing out wanted.
      if (!(error instanceof ApiError && error.status === 401)) {
        setSigningOut(false);
        setFailed(true);
        return;
      }
    }
    window.location.replace("/sign-in");
  };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title="Sign in again"
      description="This action needs a recent sign-in. Sign in again, then come back and try once more."
      actions={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button loading={signingOut} onClick={() => void signInAgain()}>
            Sign in again
          </Button>
        </>
      }
    >
      {failed && <Alert tone="danger">Signing out did not work. Try again.</Alert>}
    </Dialog>
  );
}

type ConfirmMethod = "password" | "code" | "passkey";

const methodOptions = [
  { value: "password", label: "Password" },
  { value: "code", label: "Authenticator code" },
];

/** Offered only when the account has a passkey and the browser can use it. */
const passkeyOption = { value: "passkey", label: "Passkey" };

function isConfirmMethod(value: string): value is ConfirmMethod {
  return value === "password" || value === "code" || value === "passkey";
}

function confirmErrorOf(error: unknown, method: ConfirmMethod): string {
  if (isProblem(error, problemTypes.signInFailed)) return "The password is not right.";
  if (isProblem(error, problemTypes.secondFactorFailed) && method === "passkey")
    return "The passkey was not accepted. Try again, or use another way.";
  if (isProblem(error, problemTypes.secondFactorFailed)) return "The code is not right. Check the code in your app and try again.";
  if (isProblem(error, problemTypes.tooManyAttempts) && method !== "password")
    return "Too many wrong codes. Use your password, or wait and try again.";
  return problemMessage(error, "Confirming did not work. Try again.");
}

function ConfirmDialog({ open, onConfirmed, onCancel }: ConfirmDialogProps) {
  const formId = useId();
  const passwordField = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<ConfirmMethod>("password");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The admin's passkeys, to offer confirming with one; none when the browser can't use them.
  const hasPasskeys = useCanConfirmWithPasskey(open);
  const options = hasPasskeys ? [...methodOptions, passkeyOption] : methodOptions;

  const confirmation = useMutation({
    mutationFn: async (body: SessionConfirmation | "passkey") => {
      if (body !== "passkey") return api("confirmSession", { body });
      const challenge = await api("startPasskeyConfirmation");
      const passkey = await signWithPasskey(challenge);
      return api("confirmSession", { body: { passkey } });
    },
    onSuccess: (session) => {
      queryClient.setQueryData(sessionQueryKey, session);
      onConfirmed();
    },
    onError: (caught) => {
      // The browser's own prompt ended without a passkey: PasskeyFailureAlert says so.
      if (isPasskeyCeremonyError(caught)) return;
      setError(confirmErrorOf(caught, method));
      if (method === "code") setCode("");
    },
  });

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (method === "password") {
      if (password === "") setError("Enter your password.");
      else confirmation.mutate({ password });
    } else if (method === "passkey") {
      confirmation.mutate("passkey");
    } else if (code.length !== TOTP_CODE_DIGITS) {
      setError(`Enter the ${TOTP_CODE_DIGITS}-digit code from your authenticator app.`);
    } else {
      confirmation.mutate({ code });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      initialFocus={passwordField}
      title="Confirm it's you"
      description={
        hasPasskeys
          ? "This action needs a recent sign-in. Enter your password or a code from your authenticator app, or use a passkey, to continue."
          : "This action needs a recent sign-in. Enter your password or a code from your authenticator app to continue."
      }
      actions={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={confirmation.isPending}>
            Confirm
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-3">
        <SegmentedControl
          aria-label="Confirm with"
          options={options}
          value={method}
          onChange={(value) => {
            if (!isConfirmMethod(value)) return;
            setMethod(value);
            setError(null);
            confirmation.reset();
          }}
        />
        {error !== null && <Alert tone="danger">{error}</Alert>}
        {method === "passkey" && <PasskeyFailureAlert error={confirmation.error} />}
        {method === "passkey" ? (
          <p className="m-0 type-body-sm text-fg-2">Select Confirm, then follow your browser's steps to use one of your passkeys.</p>
        ) : method === "password" ? (
          <PasswordInput ref={passwordField} label="Password" value={password} onChange={(event) => setPassword(event.target.value)} />
        ) : (
          <CodeInput label="Authenticator code" focusOnMount value={code} onChange={setCode} />
        )}
      </form>
    </Dialog>
  );
}
