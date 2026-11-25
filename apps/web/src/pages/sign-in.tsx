import { problemTypes, type SignInProvider } from "@not-unreachable/contracts";
import { Alert, AuthLayout, Button, Icon, Input, PasswordInput } from "@not-unreachable/design-system";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type * as React from "react";
import { Navigate, useLocation, useSearchParams } from "react-router";
import { ApiError, api } from "../api/index.ts";
import { browserNavigation, errorProp, problemMessage, signInProvidersQuery, usePageRestored } from "../lib/index.ts";
import { PasskeyFailureAlert, isPasskeyCeremonyError, passkeysSupported, signWithPasskey } from "../second-factors/index.ts";
import { clearAccountData, safeNextPath, savePendingNext, secondFactorPathWith, sessionQueryKey, useSession } from "../session/index.ts";

/** What /setup and the second-factor step tell the sign-in page through the router's state. */
export type SignInNotice = "admin-created" | "admin-password-set" | "second-factor-expired" | "second-factor-locked";

interface Notice {
  readonly tone: "success" | "warning";
  readonly text: string;
}

const notices: Record<SignInNotice, Notice> = {
  "admin-created": { tone: "success", text: "Admin account created. Sign in to continue." },
  "admin-password-set": { tone: "success", text: "Admin password set. Sign in to continue." },
  "second-factor-expired": { tone: "warning", text: "The sign-in took too long. Sign in again." },
  "second-factor-locked": { tone: "warning", text: "Too many wrong codes. Sign in again." },
};

function isNotice(value: unknown): value is SignInNotice {
  return typeof value === "string" && Object.hasOwn(notices, value);
}

function noticeOf(state: unknown): Notice | null {
  if (typeof state !== "object" || state === null || !("notice" in state)) return null;
  const { notice } = state;
  return isNotice(notice) ? notices[notice] : null;
}

/** One message per problem; a failed sign-in never says which part was wrong (threat model, T1). */
function signInErrorOf(error: unknown): string {
  if (!(error instanceof ApiError)) return "The server could not be reached. Check your connection and try again.";
  switch (error.type) {
    case problemTypes.signInFailed:
      return "The username, email or password is not right.";
    case problemTypes.tooManyAttempts:
    case problemTypes.rateLimited:
      return "Too many sign-in attempts. Wait a few minutes and try again.";
    case problemTypes.serviceUnavailable:
      return "Signing in is not available right now. Try again in a few minutes.";
    default:
      return "Sign-in did not work. Try again.";
  }
}

/** A passkey that passed the browser but not the server: unknown here, or the sign-in limits. */
function passkeySignInErrorOf(error: unknown): string | null {
  if (isPasskeyCeremonyError(error)) return null;
  if (error instanceof ApiError && error.type === problemTypes.signInFailed)
    return "That passkey can't sign you in. Sign in with your password, or use another passkey.";
  return signInErrorOf(error);
}

/** The `?error=` a failed single sign-on comes back with: one neutral message, whatever went wrong (threat model, T9). */
const ssoFailedMessage = "We couldn't sign you in with that account. Try again, or use another way to sign in.";

interface FieldErrors {
  identifier?: string;
  password?: string;
}

export function Component() {
  const { data: session, isPending } = useSession();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const signIn = useMutation({
    mutationFn: () => api("signIn", { body: { identifier: identifier.trim(), password } }),
    onSuccess: (signedIn) => {
      // Nothing another account loaded in this tab may show for this one.
      clearAccountData(queryClient);
      queryClient.setQueryData(sessionQueryKey, signedIn);
    },
    onError: () => setPassword(""),
  });

  // A passkey with user verification counts as both steps: the session comes back active.
  const signInWithPasskey = useMutation({
    mutationFn: async () => {
      const options = await api("startPasskeySignIn");
      const response = await signWithPasskey(options);
      return api("passkeySignIn", { body: { response } });
    },
    onMutate: (): void => {
      signIn.reset();
      startSso.reset();
    },
    onSuccess: (signedIn) => {
      clearAccountData(queryClient);
      queryClient.setQueryData(sessionQueryKey, signedIn);
    },
  });

  const providers = useQuery(signInProvidersQuery);
  const startSso = useMutation({
    mutationFn: (provider: SignInProvider) => api("startSsoSignIn", { params: { id: provider.id } }),
    onMutate: (): void => {
      signIn.reset();
      signInWithPasskey.reset();
    },
    // The provider's page is next; the button keeps spinning until the browser gets there. Its
    // callback lands on /sign-in/complete, which goes on to `?next=` kept here.
    onSuccess: ({ url }) => {
      savePendingNext(searchParams.get("next"));
      browserNavigation.assign(url);
    },
  });
  // Back from the provider's page (it refused, or the person changed their mind): the buttons work again.
  usePageRestored(startSso.reset);

  if (isPending) return null;
  // The password passed, by this form or before: the second factor is next, with `?next=` carried on.
  if (session?.state === "pendingSecondFactor") return <Navigate replace to={secondFactorPathWith(searchParams.get("next"))} />;
  // Signed in, by this form or before: go on to `?next=`, if it is safe, or the role's landing page.
  if (session != null) return <Navigate replace to={safeNextPath(searchParams.get("next"), session.account.role)} />;

  const notice = noticeOf(location.state);
  const ssoFailed = searchParams.get("error") === "sign-in-failed";
  const ssoProviders = providers.data?.providers ?? [];
  const showNotice = !signIn.isError && !startSso.isError && !signInWithPasskey.isError;
  const passkeys = passkeysSupported();
  const passkeyError = signInWithPasskey.isError ? passkeySignInErrorOf(signInWithPasskey.error) : null;
  const busy = startSso.isPending || startSso.isSuccess || signInWithPasskey.isPending;

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors: FieldErrors = {};
    if (identifier.trim() === "") errors.identifier = "Enter your username or email.";
    if (password === "") errors.password = "Enter your password.";
    setFieldErrors(errors);
    if (errors.identifier === undefined && errors.password === undefined) signIn.mutate();
  };

  return (
    <AuthLayout title="Sign in" description="Use your NotUnreachable account." footer="Every sign-in is logged.">
      {notice !== null && showNotice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {ssoFailed && showNotice && <Alert tone="danger">{ssoFailedMessage}</Alert>}
      {signIn.isError && <Alert tone="danger">{signInErrorOf(signIn.error)}</Alert>}
      {startSso.isError && <Alert tone="danger">{problemMessage(startSso.error, "Signing in this way did not work. Try again.")}</Alert>}
      {providers.isError && (
        <Alert
          tone="warning"
          action={
            <Button variant="secondary" size="sm" onClick={() => void providers.refetch()}>
              Try again
            </Button>
          }
        >
          The other ways to sign in could not be loaded. You can still sign in with your password.
        </Alert>
      )}
      {signInWithPasskey.isError && <PasskeyFailureAlert error={signInWithPasskey.error} />}
      {passkeyError !== null && <Alert tone="danger">{passkeyError}</Alert>}
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <Input
          size="lg"
          label="Username or email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          {...errorProp(fieldErrors.identifier)}
        />
        <PasswordInput
          size="lg"
          label="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          {...errorProp(fieldErrors.password)}
        />
        <Button type="submit" variant="accent" size="lg" fullWidth loading={signIn.isPending}>
          Sign in
        </Button>
      </form>
      {(passkeys || ssoProviders.length > 0) && (
        <>
          <div className="flex items-center gap-3">
            <hr className="m-0 flex-1 border-0 border-t border-solid border-border-subtle" />
            <span className="type-caption text-fg-3">or</span>
            <hr className="m-0 flex-1 border-0 border-t border-solid border-border-subtle" />
          </div>
          <div className="flex flex-col gap-2">
            {passkeys && (
              <Button
                variant="secondary"
                size="lg"
                fullWidth
                iconLeft={<Icon name="key-round" size={16} />}
                loading={signInWithPasskey.isPending}
                disabled={busy}
                onClick={() => signInWithPasskey.mutate()}
              >
                Sign in with a passkey
              </Button>
            )}
            {ssoProviders.map((provider) => (
              <Button
                key={provider.id}
                variant="secondary"
                size="lg"
                fullWidth
                iconLeft={<Icon name="log-in" size={16} />}
                loading={(startSso.isPending || startSso.isSuccess) && startSso.variables.id === provider.id}
                disabled={busy}
                onClick={() => startSso.mutate(provider)}
              >
                Continue with {provider.name}
              </Button>
            ))}
          </div>
        </>
      )}
    </AuthLayout>
  );
}
