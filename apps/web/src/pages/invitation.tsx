import {
  acceptFailures,
  displayNameSchema,
  problemTypes,
  usernameSchema,
  type AcceptFailure,
  type AcceptInvitationRequest,
  type InvitationOffer,
  type SignInProvider,
} from "@not-unreachable/contracts";
import { Alert, AuthLayout, Button, Input } from "@not-unreachable/design-system";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { z } from "zod";
import { ApiError, api } from "../api/index.ts";
import { browserNavigation, errorProp, isProblem, problemMessage, usePageRestored } from "../lib/index.ts";
import { LinkNotValid, NoProviders, ProviderButtons } from "./link-pages.tsx";

const usernameHint = "3–32 lowercase letters, digits, dots, dashes or underscores. It can't change later.";
const usernameInvalidMessage = "Use 3–32 lowercase letters, digits, dots, dashes or underscores.";
const usernameTakenMessage = "This username is taken.";
const usernameReservedMessage = "This username isn't available.";

function isAcceptFailure(value: string | null): value is AcceptFailure {
  return acceptFailures.some((failure) => failure === value);
}

/** Any 404 from the invitation routes means the link is unknown, expired, used or revoked. */
function isInvalidLink(error: unknown): boolean {
  return isProblem(error, problemTypes.invitationInvalid) || (error instanceof ApiError && error.status === 404);
}

/*
 * What was typed before leaving for the provider, so a page sent back with `?error=` shows it again.
 * Kept in this tab only, and read once.
 */
const draftKey = "invitation-draft";

const draftSchema = z.object({
  token: z.string(),
  providerId: z.string(),
  username: z.string(),
  displayName: z.string(),
});

type Draft = z.infer<typeof draftSchema>;

function saveDraft(draft: Draft): void {
  try {
    sessionStorage.setItem(draftKey, JSON.stringify(draft));
  } catch {
    // Storage is refused (private mode, quota): the fields simply start afresh on the way back.
  }
}

function takeDraft(token: string): Draft | null {
  try {
    const text = sessionStorage.getItem(draftKey);
    sessionStorage.removeItem(draftKey);
    if (text === null) return null;
    const parsed = draftSchema.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.token === token ? parsed.data : null;
  } catch {
    return null;
  }
}

interface FieldErrors {
  username?: string;
  displayName?: string;
}

function fieldErrorsOf(failure: AcceptFailure | null): FieldErrors {
  if (failure === "username-taken") return { username: usernameTakenMessage };
  if (failure === "username-reserved") return { username: usernameReservedMessage };
  return {};
}

/** `/invitation/:token`: a new user chooses a username and signs in with a provider to create their account. */
export function Component() {
  const { token = "" } = useParams();
  const [searchParams] = useSearchParams();
  const returned = searchParams.get("error");
  const failure = isAcceptFailure(returned) ? returned : null;
  const [linkInvalid, setLinkInvalid] = useState(failure === "invitation-invalid");
  const offer = useQuery({
    queryKey: ["invitation", token] as const,
    queryFn: ({ signal }) => api("getInvitation", { params: { token }, signal }),
    enabled: !linkInvalid,
  });

  if (linkInvalid || (offer.isError && isInvalidLink(offer.error))) return <LinkNotValid />;
  if (offer.isPending) return null;
  if (offer.isError) {
    return (
      <AuthLayout title="Create your account">
        <Alert
          tone="danger"
          action={
            <Button variant="secondary" size="sm" onClick={() => void offer.refetch()}>
              Try again
            </Button>
          }
        >
          {problemMessage(offer.error, "This invitation could not be loaded. Try again.")}
        </Alert>
      </AuthLayout>
    );
  }
  return <InvitationForm token={token} offer={offer.data} failure={failure} onInvalidLink={() => setLinkInvalid(true)} />;
}

interface InvitationFormProps {
  readonly token: string;
  readonly offer: InvitationOffer;
  readonly failure: AcceptFailure | null;
  readonly onInvalidLink: () => void;
}

function InvitationForm({ token, offer, failure, onInvalidLink }: InvitationFormProps) {
  const [draft] = useState(() => (failure === null ? null : takeDraft(token)));
  const [username, setUsername] = useState(draft?.username ?? offer.suggestedUsername ?? "");
  const [displayName, setDisplayName] = useState(draft?.displayName ?? "");
  const [errors, setErrors] = useState<FieldErrors>(() => fieldErrorsOf(failure));
  // The failure the provider's round trip came back with, until the next try.
  const [returned, setReturned] = useState<AcceptFailure | null>(failure);

  const accept = useMutation({
    mutationFn: (body: AcceptInvitationRequest) => api("acceptInvitation", { params: { token }, body }),
    onMutate: (body): void => {
      setReturned(null);
      saveDraft({ token, ...body });
    },
    // The provider's page is next; the button keeps spinning until the browser gets there.
    onSuccess: ({ url }) => browserNavigation.assign(url),
    onError: (error) => {
      if (isInvalidLink(error)) onInvalidLink();
      else if (isProblem(error, problemTypes.usernameTaken)) setErrors({ username: usernameTakenMessage });
      else if (isProblem(error, problemTypes.usernameReserved)) setErrors({ username: usernameReservedMessage });
    },
  });
  // Back from the provider's page (it refused, or the person changed their mind): the buttons work again.
  usePageRestored(accept.reset);

  const start = (provider: SignInProvider) => {
    const found: FieldErrors = {};
    const parsedUsername = usernameSchema.safeParse(username.trim());
    const parsedName = displayNameSchema.safeParse(displayName);
    if (!parsedUsername.success) found.username = usernameInvalidMessage;
    if (!parsedName.success) found.displayName = "Enter a name of up to 100 characters.";
    setErrors(found);
    if (!parsedUsername.success || !parsedName.success) return;
    accept.mutate({ providerId: provider.id, username: parsedUsername.data, displayName: parsedName.data });
  };

  const usedProvider = offer.providers.find((provider) => provider.id === draft?.providerId);
  const showGeneralError =
    accept.isError && !isProblem(accept.error, problemTypes.usernameTaken) && !isProblem(accept.error, problemTypes.usernameReserved);
  const busy = accept.isPending || accept.isSuccess;

  return (
    <AuthLayout title="Create your account" description="Choose your username, then sign in with one of these to finish.">
      {returned === "identity-already-linked" && (
        <Alert tone="danger">
          {usedProvider === undefined ? "This account" : `This ${usedProvider.name} account`} is already linked to another account. Sign in
          with it instead, or use another one.
        </Alert>
      )}
      {returned === "email-not-verified" && (
        <Alert tone="danger">
          The provider did not report a verified email for that account. Verify your email with the provider, or use another account or
          provider.
        </Alert>
      )}
      {returned === "email-mismatch" && (
        <Alert tone="danger">
          That account's verified email is not the one this invitation is for. Sign in with the account that has that email.
        </Alert>
      )}
      {returned === "accept-failed" && <Alert tone="danger">Your account could not be created. Try again.</Alert>}
      {showGeneralError && <Alert tone="danger">{problemMessage(accept.error, "Your account could not be created. Try again.")}</Alert>}
      <div className="flex flex-col gap-4">
        <Input
          label="Username"
          hint={usernameHint}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          {...errorProp(errors.username)}
        />
        <Input
          label="Display name"
          autoComplete="name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          {...errorProp(errors.displayName)}
        />
      </div>
      {offer.verifyEmail && (
        <p className="m-0 type-body-sm text-fg-2">Sign in with an account whose verified email is the one this invitation was sent to.</p>
      )}
      {offer.providers.length === 0 ? (
        <NoProviders />
      ) : (
        <ProviderButtons providers={offer.providers} startingId={busy ? accept.variables.providerId : null} onStart={start} />
      )}
    </AuthLayout>
  );
}
