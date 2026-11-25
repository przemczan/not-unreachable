import type { SsoProviderKind } from "@not-unreachable/contracts";
import { Disclosure, Icon } from "@not-unreachable/design-system";
import type * as React from "react";

interface HelpLink {
  readonly label: string;
  readonly href: string;
}

/** What an admin does at one kind of provider, in order. The steps match what the server asks for (`apps/server/src/modules/sso/protocol.ts`). */
interface ProviderHelp {
  readonly steps: (publicOrigin: string) => readonly React.ReactNode[];
  readonly links: readonly HelpLink[];
}

const Mono = ({ children }: { readonly children: React.ReactNode }) => <span className="type-mono text-fg-1">{children}</span>;

export const providerHelp: Record<SsoProviderKind, ProviderHelp> = {
  google: {
    steps: () => [
      <>
        In the Google Cloud Console, open <strong>Google Auth Platform</strong>, then <strong>Clients</strong>. If it asks, set up the
        consent screen first (<strong>Branding</strong> and <strong>Audience</strong>): it is what people see when they sign in.
      </>,
      <>
        Select <strong>Create client</strong> and choose the application type <strong>Web application</strong>.
      </>,
      <>
        Under <strong>Authorized redirect URIs</strong>, add the Redirect URI below.
      </>,
      <>
        Select <strong>Create</strong>, then copy the <strong>Client ID</strong> and <strong>Client secret</strong> into this form. Google
        shows the secret only once.
      </>,
      <>
        Sign-in asks for <Mono>openid email profile</Mono> only, so the app needs no verification by Google.
      </>,
      <>
        With the audience <strong>External</strong>, select <strong>Publish app</strong> under <strong>Audience</strong>: while it is in
        testing, only the test users listed there can sign in.
      </>,
    ],
    links: [
      { label: "Google Auth Platform: Clients", href: "https://console.cloud.google.com/auth/clients" },
      { label: "Google's guide to OAuth clients", href: "https://support.google.com/cloud/answer/15549257" },
    ],
  },
  github: {
    steps: (publicOrigin) => [
      <>
        On GitHub, open <strong>Settings</strong>, then <strong>Developer settings</strong>, then <strong>OAuth Apps</strong>, and select{" "}
        <strong>New OAuth App</strong>. For an organization, start from the organization's settings instead.
      </>,
      <>
        As the <strong>Homepage URL</strong>, enter <Mono>{publicOrigin}</Mono>.
      </>,
      <>
        As the <strong>Authorization callback URL</strong>, enter the Redirect URI below.
      </>,
      <>
        Select <strong>Register application</strong>, then <strong>Generate a new client secret</strong>. Copy the{" "}
        <strong>Client ID</strong> and the secret into this form.
      </>,
      <>
        Sign-in asks for <Mono>read:user user:email</Mono>: the account's id, name and verified email.
      </>,
    ],
    links: [
      { label: "GitHub: OAuth Apps", href: "https://github.com/settings/developers" },
      {
        label: "GitHub's guide to creating an OAuth app",
        href: "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app",
      },
    ],
  },
  oidc: {
    steps: () => [
      <>
        At the provider, create a confidential client (often called a web application) that uses the authorization code flow with PKCE (
        <Mono>S256</Mono>).
      </>,
      <>Register the Redirect URI below as its redirect or callback URL.</>,
      <>
        Let the client authenticate with a client secret sent in the request body (<Mono>client_secret_post</Mono>), and allow the scopes{" "}
        <Mono>openid email profile</Mono>.
      </>,
      <>
        As the <strong>Issuer</strong>, enter the <Mono>issuer</Mono> exactly as the provider's{" "}
        <Mono>/.well-known/openid-configuration</Mono> gives it, trailing slash included. It must be an https:// address this server can
        reach: it is checked when you save.
      </>,
      <>Copy the client ID and client secret into this form.</>,
    ],
    links: [{ label: "OpenID Connect Discovery", href: "https://openid.net/specs/openid-connect-discovery-1_0.html" }],
  },
};

export interface SignInProviderHelpProps {
  readonly kind: SsoProviderKind;
  /** Where this server is reached, for the steps that ask for it. */
  readonly publicOrigin: string;
  readonly defaultOpen: boolean;
}

/** "How to set this up": the steps and links for the chosen kind of provider. */
export function SignInProviderHelp({ kind, publicOrigin, defaultOpen }: SignInProviderHelpProps) {
  const help = providerHelp[kind];
  return (
    <Disclosure title="How to set this up" defaultOpen={defaultOpen}>
      <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5">
        {help.steps(publicOrigin).map((step, index) => (
          // A fixed list: a step's place is its identity.
          <li key={index}>{step}</li>
        ))}
      </ol>
      <ul className="m-0 mt-3 flex list-none flex-col gap-1 p-0">
        {help.links.map((link) => (
          <li key={link.href}>
            <a href={link.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
              {link.label}
              <Icon name="external-link" size={14} />
            </a>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
