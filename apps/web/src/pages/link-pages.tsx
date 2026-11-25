import type { SignInProvider } from "@not-unreachable/contracts";
import { Alert, AuthLayout, Button, Icon } from "@not-unreachable/design-system";

/**
 * What the invitation and re-link pages show for an unknown, expired, used or revoked link: the
 * same words whatever the reason (threat model, T1).
 */
export function LinkNotValid() {
  return (
    <AuthLayout title="This link is not valid">
      <p className="m-0 type-body text-fg-2">It may have expired, been used already or been revoked. Ask the admin for a new one.</p>
    </AuthLayout>
  );
}

export function NoProviders() {
  return (
    <Alert tone="warning" title="No way to sign in yet">
      No sign-in providers are turned on. Ask the admin to set one up, then open this link again.
    </Alert>
  );
}

export interface ProviderButtonsProps {
  readonly providers: readonly SignInProvider[];
  /** The provider being started, whose button spins; the others are disabled meanwhile. */
  readonly startingId: string | null;
  readonly onStart: (provider: SignInProvider) => void;
}

/** One "Continue with …" button per provider, as on the sign-in page. */
export function ProviderButtons({ providers, startingId, onStart }: ProviderButtonsProps) {
  return (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        <Button
          key={provider.id}
          variant="secondary"
          size="lg"
          fullWidth
          iconLeft={<Icon name="log-in" size={16} />}
          loading={startingId === provider.id}
          disabled={startingId !== null}
          onClick={() => onStart(provider)}
        >
          Continue with {provider.name}
        </Button>
      ))}
    </div>
  );
}
