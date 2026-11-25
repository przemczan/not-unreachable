import { problemTypes, relinkFailures, type RelinkFailure, type SignInProvider } from "@not-unreachable/contracts";
import { Alert, AuthLayout, Button } from "@not-unreachable/design-system";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { ApiError, api } from "../api/index.ts";
import { browserNavigation, isProblem, problemMessage, usePageRestored } from "../lib/index.ts";
import { LinkNotValid, NoProviders, ProviderButtons } from "./link-pages.tsx";

function isRelinkFailure(value: string | null): value is RelinkFailure {
  return relinkFailures.some((failure) => failure === value);
}

/** Any 404 from the re-link routes means the link is unknown, expired, used or revoked. */
function isInvalidLink(error: unknown): boolean {
  return isProblem(error, problemTypes.invitationInvalid) || (error instanceof ApiError && error.status === 404);
}

const returnedMessages: Record<Exclude<RelinkFailure, "invitation-invalid">, string> = {
  "identity-already-linked": "This account is already linked to another account. Use another one.",
  "relink-failed": "The new sign-in could not be linked. Try again.",
};

const title = "Link a new sign-in";

/**
 * `/relink/:token`: a user who lost their way to sign in links a new provider account in place of
 * their old linked sign-ins.
 */
export function Component() {
  const { token = "" } = useParams();
  const [searchParams] = useSearchParams();
  const errorParam = searchParams.get("error");
  const failure = isRelinkFailure(errorParam) ? errorParam : null;
  const [linkInvalid, setLinkInvalid] = useState(failure === "invitation-invalid");
  const [returned, setReturned] = useState(failure === "invitation-invalid" ? null : failure);
  const offer = useQuery({
    queryKey: ["relink", token] as const,
    queryFn: ({ signal }) => api("getRelink", { params: { token }, signal }),
    enabled: !linkInvalid,
  });

  const start = useMutation({
    mutationFn: (provider: SignInProvider) => api("startRelink", { params: { token }, body: { providerId: provider.id } }),
    onMutate: (): void => setReturned(null),
    // The provider's page is next; the button keeps spinning until the browser gets there.
    onSuccess: ({ url }) => browserNavigation.assign(url),
    onError: (error) => {
      if (isInvalidLink(error)) setLinkInvalid(true);
    },
  });
  // Back from the provider's page (it refused, or the person changed their mind): the buttons work again.
  usePageRestored(start.reset);

  if (linkInvalid || (offer.isError && isInvalidLink(offer.error))) return <LinkNotValid />;
  if (offer.isPending) return null;
  if (offer.isError) {
    return (
      <AuthLayout title={title}>
        <Alert
          tone="danger"
          action={
            <Button variant="secondary" size="sm" onClick={() => void offer.refetch()}>
              Try again
            </Button>
          }
        >
          {problemMessage(offer.error, "This link could not be loaded. Try again.")}
        </Alert>
      </AuthLayout>
    );
  }

  const { providers } = offer.data;
  const busy = start.isPending || start.isSuccess;

  return (
    <AuthLayout title={title} description="Sign in with the account you want to use from now on. It replaces your old linked sign-ins.">
      {returned !== null && <Alert tone="danger">{returnedMessages[returned]}</Alert>}
      {start.isError && <Alert tone="danger">{problemMessage(start.error, "Signing in this way did not work. Try again.")}</Alert>}
      {providers.length === 0 ? (
        <NoProviders />
      ) : (
        <ProviderButtons
          providers={providers}
          startingId={busy ? start.variables.id : null}
          onStart={(provider) => start.mutate(provider)}
        />
      )}
    </AuthLayout>
  );
}
