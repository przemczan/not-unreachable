import {
  RECOVERY_CODE_LENGTH,
  TOTP_CODE_DIGITS,
  problemTypes,
  type SecondFactorKind,
  type SecondFactorMethod,
  type Session,
} from "@not-unreachable/contracts";
import { Alert, AuthLayout, Button, CodeInput, Icon, Input } from "@not-unreachable/design-system";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as React from "react";
import { Navigate, useSearchParams } from "react-router";
import { api } from "../api/index.ts";
import { errorProp, isProblem, problemMessage } from "../lib/index.ts";
import {
  AuthenticatorSetup,
  PasskeyFailureAlert,
  PasskeysUnsupportedAlert,
  RecoveryCodesPanel,
  PasskeyNameForm,
  createPasskey,
  isPasskeyCeremonyError,
  missingCodeMessage,
  passkeysSupported,
  signWithPasskey,
} from "../second-factors/index.ts";
import { clearAccountData, safeNextPath, sessionQueryKey, useSession } from "../session/index.ts";
import type { SignInNotice } from "./sign-in.tsx";

const stepQueryKey = ["sign-in", "second-factor-step"] as const;

const wrongCodeMessage = "The code is not right. Check the code in your app and try again.";
const wrongRecoveryCodeMessage = "The recovery code is not right, or it was used already.";
const wrongPasskeyMessage = "The passkey was not accepted. Try again, or use another way to sign in.";

const methodDescriptions: Record<SecondFactorMethod, string> = {
  totp: "Enter the code from your authenticator app.",
  passkey: "Use one of your passkeys to finish signing in.",
  recoveryCode: "Enter one of the recovery codes you saved.",
};

const switchLabels: Record<SecondFactorMethod, string> = {
  totp: "Use your authenticator app",
  passkey: "Use a passkey",
  recoveryCode: "Use a recovery code",
};

/** The method the step opens with: the authenticator app, else a passkey, else a recovery code. */
function firstMethodOf(methods: readonly SecondFactorMethod[]): SecondFactorMethod {
  if (methods.includes("totp")) return "totp";
  if (methods.includes("passkey")) return "passkey";
  return "recoveryCode";
}

function signInPath(next: string | null): string {
  return next === null || next === "" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(next)}`;
}

/**
 * The notice for an attempt the server ended: the pending session timed out (sign-in-required) or
 * was revoked by the try limits (too-many-attempts). Null for any other error.
 */
function endedNoticeOf(error: unknown): SignInNotice | null {
  if (isProblem(error, problemTypes.signInRequired)) return "second-factor-expired";
  if (isProblem(error, problemTypes.tooManyAttempts)) return "second-factor-locked";
  return null;
}

/** Why the server ended the attempt, for the sign-in page; account data, so the next sign-in clears it. */
const endedNoticeQueryKey = ["sign-in", "ended-notice"] as const;

/**
 * Back to the password when the server ended the attempt: the session is forgotten, and the page
 * says why on its way to /sign-in. True when it did.
 */
function useEndedAttempt(): (error: unknown) => boolean {
  const queryClient = useQueryClient();
  return useCallback(
    (error: unknown) => {
      const notice = endedNoticeOf(error);
      if (notice === null) return false;
      clearAccountData(queryClient);
      queryClient.setQueryData(endedNoticeQueryKey, notice);
      return true;
    },
    [queryClient],
  );
}

/** Ends the attempt when a query of this page fails because the server ended it. */
function useEndedAttemptOnQuery(error: unknown): void {
  const endedAttempt = useEndedAttempt();
  useEffect(() => {
    if (error != null) endedAttempt(error);
  }, [error, endedAttempt]);
}

/**
 * Passing the step makes the session active. The pending session could load nothing but this
 * step, which the next sign-in clears; clearing it here would refetch it while still on screen.
 */
function useEnterSession(): (session: Session) => void {
  const queryClient = useQueryClient();
  return useCallback((session: Session) => queryClient.setQueryData(sessionQueryKey, session), [queryClient]);
}

/** The sign-in step after the password: an authenticator code or a recovery code, or adding an app first. */
export function Component() {
  const { data: session, isPending } = useSession();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next");

  if (isPending) return null;
  if (session == null) {
    const notice = queryClient.getQueryData<SignInNotice>(endedNoticeQueryKey);
    return <Navigate replace to={signInPath(next)} state={notice === undefined ? undefined : { notice }} />;
  }
  // Passed, by this page or before: go on to `?next=`, if it is safe, or the role's landing page.
  if (session.state === "active") return <Navigate replace to={safeNextPath(next, session.account.role)} />;
  return <SecondFactorStep username={session.account.username} />;
}

interface StepProps {
  readonly username: string;
}

function SecondFactorStep({ username }: StepProps) {
  const queryClient = useQueryClient();
  const step = useQuery({ queryKey: stepQueryKey, queryFn: ({ signal }) => api("getSecondFactorStep", { signal }) });
  useEndedAttemptOnQuery(step.error);

  const startAgain = useMutation({
    mutationFn: () => api("signOut"),
    // Signed out either way: a 401 means the pending session had already ended.
    onSettled: () => clearAccountData(queryClient),
  });

  const startAgainButton = (
    <Button variant="ghost" size="sm" loading={startAgain.isPending} onClick={() => startAgain.mutate()}>
      Start again
    </Button>
  );

  if (step.isPending) return <AuthLayout title="Two-step sign-in" footer="Every sign-in is logged." />;
  if (step.isError) {
    if (endedNoticeOf(step.error) !== null) return null;
    return (
      <AuthLayout title="Two-step sign-in" footer="Every sign-in is logged.">
        <Alert
          tone="danger"
          action={
            <Button variant="secondary" size="sm" onClick={() => void step.refetch()}>
              Try again
            </Button>
          }
        >
          {problemMessage(step.error, "The sign-in step could not be loaded.")}
        </Alert>
        <div className="flex justify-end">{startAgainButton}</div>
      </AuthLayout>
    );
  }
  if (step.data.mode === "enrol") return <Enrol username={username} startAgainButton={startAgainButton} />;
  return <Verify methods={step.data.methods} startAgainButton={startAgainButton} />;
}

interface VerifyProps {
  readonly methods: readonly SecondFactorMethod[];
  readonly startAgainButton: React.ReactNode;
}

function Verify({ methods, startAgainButton }: VerifyProps) {
  const endedAttempt = useEndedAttempt();
  const enterSession = useEnterSession();
  const [method, setMethod] = useState<SecondFactorMethod>(() => firstMethodOf(methods));
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const codeField = useRef<HTMLInputElement>(null);

  const pass = useMutation({
    mutationFn: (entered: { readonly method: SecondFactorMethod; readonly code: string }) =>
      entered.method === "totp"
        ? api("passTotp", { body: { code: entered.code } })
        : api("passRecoveryCode", { body: { code: entered.code } }),
    onSuccess: enterSession,
    onError: (error, entered) => {
      if (endedAttempt(error)) return;
      if (isProblem(error, problemTypes.secondFactorFailed)) {
        setFieldError(entered.method === "totp" ? wrongCodeMessage : wrongRecoveryCodeMessage);
        if (entered.method === "totp") {
          setCode("");
          codeField.current?.focus();
        }
      } else {
        setFieldError(problemMessage(error, "Checking the code did not work. Try again."));
      }
    },
  });

  const passWithPasskey = useMutation({
    mutationFn: async () => {
      const options = await api("startPasskeySecondFactor");
      const response = await signWithPasskey(options);
      return api("passPasskey", { body: { response } });
    },
    onSuccess: enterSession,
    onError: (error) => {
      endedAttempt(error);
    },
  });

  const switchTo = (other: SecondFactorMethod) => {
    setMethod(other);
    setFieldError(null);
    pass.reset();
    passWithPasskey.reset();
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (method === "totp") {
      if (code.length !== TOTP_CODE_DIGITS) setFieldError(missingCodeMessage);
      else pass.mutate({ method, code });
    } else if (recoveryCode.trim().length < RECOVERY_CODE_LENGTH) {
      setFieldError("Enter one of your recovery codes, such as ABCDE-FGH23.");
    } else {
      pass.mutate({ method, code: recoveryCode.trim() });
    }
  };

  // The other ways in, in a fixed order: the authenticator app, a passkey, then a recovery code.
  const others = (["totp", "passkey", "recoveryCode"] as const).filter((other) => other !== method && methods.includes(other));
  const passkeyError = passWithPasskey.error;
  const passkeyFailed = passkeyError !== null && !isPasskeyCeremonyError(passkeyError) && endedNoticeOf(passkeyError) === null;

  return (
    <AuthLayout title="Two-step sign-in" description={methodDescriptions[method]} footer="Every sign-in is logged.">
      {method === "passkey" ? (
        <div className="flex flex-col gap-4">
          {!passkeysSupported() && <PasskeysUnsupportedAlert />}
          <PasskeyFailureAlert error={passkeyError} />
          {passkeyFailed && (
            <Alert tone="danger">
              {isProblem(passkeyError, problemTypes.secondFactorFailed)
                ? wrongPasskeyMessage
                : problemMessage(passkeyError, "Checking the passkey did not work. Try again.")}
            </Alert>
          )}
          <Button
            variant="accent"
            size="lg"
            fullWidth
            iconLeft={<Icon name="key-round" size={16} />}
            disabled={!passkeysSupported()}
            loading={passWithPasskey.isPending}
            onClick={() => passWithPasskey.mutate()}
          >
            Use passkey
          </Button>
        </div>
      ) : (
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          {method === "totp" ? (
            <CodeInput
              key="totp"
              ref={codeField}
              label="Authenticator code"
              focusOnMount
              value={code}
              onChange={(value) => {
                setCode(value);
                setFieldError(null);
              }}
              {...errorProp(fieldError ?? undefined)}
            />
          ) : (
            <Input
              key="recovery-code"
              size="lg"
              label="Recovery code"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="ABCDE-FGH23"
              value={recoveryCode}
              onChange={(event) => {
                setRecoveryCode(event.target.value);
                setFieldError(null);
              }}
              {...errorProp(fieldError ?? undefined)}
            />
          )}
          <Button type="submit" variant="accent" size="lg" fullWidth loading={pass.isPending}>
            Verify
          </Button>
        </form>
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col items-start gap-1">
          {others.map((other) => (
            <Button key={other} variant="ghost" size="sm" onClick={() => switchTo(other)}>
              {switchLabels[other]}
            </Button>
          ))}
        </div>
        {startAgainButton}
      </div>
    </AuthLayout>
  );
}

interface EnrolProps {
  readonly username: string;
  readonly startAgainButton: React.ReactNode;
}

function Enrol({ username, startAgainButton }: EnrolProps) {
  const endedAttempt = useEndedAttempt();
  const enterSession = useEnterSession();
  const [codeError, setCodeError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [kind, setKind] = useState<SecondFactorKind>("totp");

  // Started once per visit, as a mutation so nothing refetches it: each start makes a new key,
  // and only one shown can be confirmed.
  const enrolment = useMutation({ mutationFn: () => api("startTotpEnrolment"), onError: endedAttempt });
  const startEnrolment = enrolment.mutate;
  const enrolmentStarted = useRef(false);
  useEffect(() => {
    if (enrolmentStarted.current) return;
    enrolmentStarted.current = true;
    startEnrolment();
  }, [startEnrolment]);

  const confirm = useMutation({
    mutationFn: (entered: { readonly id: string; readonly code: string }) => api("confirmTotpEnrolment", { body: entered }),
    onMutate: (): void => setCodeError(null),
    onSuccess: (answer) => setRecoveryCodes(answer.recoveryCodes),
    onError: (error) => {
      if (endedAttempt(error)) return;
      setCodeError(
        isProblem(error, problemTypes.secondFactorFailed)
          ? wrongCodeMessage
          : problemMessage(error, "Adding the app did not work. Try again."),
      );
    },
  });

  const addPasskey = useMutation({
    mutationFn: async (name: string) => {
      const options = await api("startPasskeyEnrolment");
      const response = await createPasskey(options);
      return api("confirmPasskeyEnrolment", { body: { name, response } });
    },
    onSuccess: (answer) => setRecoveryCodes(answer.recoveryCodes),
    onError: (error) => {
      endedAttempt(error);
    },
  });

  const acknowledge = useMutation({
    mutationFn: () => api("acknowledgeRecoveryCodes"),
    onSuccess: enterSession,
    onError: (error) => {
      endedAttempt(error);
    },
  });

  if (recoveryCodes !== null) {
    return (
      <AuthLayout title="Save your recovery codes" description="Two-step sign-in is on." footer="Every sign-in is logged.">
        {acknowledge.isError && <Alert tone="danger">{problemMessage(acknowledge.error, "Continuing did not work. Try again.")}</Alert>}
        <RecoveryCodesPanel codes={recoveryCodes} username={username} saved={saved} onSavedChange={setSaved} />
        <Button variant="accent" size="lg" fullWidth disabled={!saved} loading={acknowledge.isPending} onClick={() => acknowledge.mutate()}>
          Continue
        </Button>
      </AuthLayout>
    );
  }

  const switchButton =
    kind === "passkey" ? (
      <Button variant="ghost" size="sm" onClick={() => setKind("totp")}>
        Add an authenticator app instead
      </Button>
    ) : passkeysSupported() ? (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          addPasskey.reset();
          setKind("passkey");
        }}
      >
        Add a passkey instead
      </Button>
    ) : (
      <span />
    );

  if (kind === "passkey") {
    return (
      <AuthLayout
        title="Set up two-step sign-in"
        description="Add a passkey to your account before you go on."
        footer="Every sign-in is logged."
      >
        <PasskeyFailureAlert error={addPasskey.error} />
        {addPasskey.isError && !isPasskeyCeremonyError(addPasskey.error) && endedNoticeOf(addPasskey.error) === null && (
          <Alert tone="danger">{problemMessage(addPasskey.error, "Adding the passkey did not work. Try again.")}</Alert>
        )}
        <PasskeyNameForm size="lg" loading={addPasskey.isPending} onSubmit={(name) => addPasskey.mutate(name)}>
          <Button
            type="submit"
            variant="accent"
            size="lg"
            fullWidth
            iconLeft={<Icon name="key-round" size={16} />}
            loading={addPasskey.isPending}
          >
            Add passkey
          </Button>
        </PasskeyNameForm>
        <div className="flex items-center justify-between gap-2">
          {switchButton}
          {startAgainButton}
        </div>
      </AuthLayout>
    );
  }

  const started = enrolment.data;
  const enrolmentFailed = enrolment.isError && endedNoticeOf(enrolment.error) === null;
  return (
    <AuthLayout
      title="Set up two-step sign-in"
      description="Add an authenticator app to your account before you go on."
      footer="Every sign-in is logged."
    >
      {enrolmentFailed && (
        <Alert tone="danger">{problemMessage(enrolment.error, "The authenticator app could not be set up. Start again.")}</Alert>
      )}
      {started !== undefined && (
        <AuthenticatorSetup enrolment={started} error={codeError} onSubmit={(code) => confirm.mutate({ id: started.id, code })}>
          <Button type="submit" variant="accent" size="lg" fullWidth loading={confirm.isPending}>
            Add authenticator app
          </Button>
        </AuthenticatorSetup>
      )}
      <div className="flex items-center justify-between gap-2">
        {switchButton}
        {startAgainButton}
      </div>
    </AuthLayout>
  );
}
