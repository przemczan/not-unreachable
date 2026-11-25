import {
  fixedIssuers,
  problemTypes,
  ssoCallbackPath,
  type addSsoProviderRequestSchema,
  type changeSsoProviderRequestSchema,
  type SignInProvider,
  type SsoProvider,
  type SsoProviderKind,
} from "@not-unreachable/contracts";
import type { z } from "zod";
import { HttpProblem } from "../../http/index.ts";
import type { AuditActor, AuditDetails, AuditOrigin, AuditService } from "../audit/index.ts";
import { absoluteUrl, newId, type Clock, type EnvelopeAad, type Secrets } from "../platform/index.ts";
import { DiscoveryFailedError, type ProviderEndpoint, type SsoProtocol } from "./protocol.ts";
import type { ProviderChange, SsoRepository } from "./repository.ts";
import type { SsoProviderRow } from "./schema.ts";

export type NewSsoProvider = z.output<typeof addSsoProviderRequestSchema>;
export type SsoProviderChange = z.output<typeof changeSsoProviderRequestSchema>;
type ChangedField = AuditDetails<"sso-provider.changed">["fields"][number];

/** Who acts, and from where, for the audit log. */
export interface ActionContext {
  readonly actor: AuditActor;
  readonly origin?: AuditOrigin;
}

/** A provider as the other parts of the module see it; never its secret. */
export interface SsoProviderRecord {
  readonly id: string;
  readonly kind: SsoProviderKind;
  readonly name: string;
  readonly issuer: string;
  readonly enabled: boolean;
}

/**
 * The admin's Sign-in providers tab. Every refusal is an `HttpProblem`: 404, 409 `ssoIssuerTaken`,
 * 409 `ssoProviderIdTaken`, 422 `ssoDiscoveryFailed`, 422 `validationFailed` for an issuer on a kind with a fixed one, and 409
 * `ssoProviderInUse` for removing a provider with linked sign-ins or changing its issuer.
 */
export interface SsoProvidersService {
  /** Oldest first. */
  list(): SsoProvider[];
  /** `PUBLIC_ORIGIN`, which every redirect URI is on. */
  readonly publicOrigin: string;
  /** The enabled providers, as the sign-in page offers them. */
  listForSignIn(): SignInProvider[];
  find(id: string): SsoProviderRecord | undefined;
  /** The provider with its decrypted client secret, for the protocol layer. */
  endpointOf(id: string): (SsoProviderRecord & ProviderEndpoint) | undefined;
  add(provider: NewSsoProvider, context: ActionContext): Promise<SsoProvider>;
  change(id: string, change: SsoProviderChange, context: ActionContext): Promise<SsoProvider>;
  remove(id: string, context: ActionContext): void;
}

export interface SsoProvidersDependencies {
  readonly repository: SsoRepository;
  readonly protocol: SsoProtocol;
  /** The master key's secrets; the CLI has none, so it can't add a provider or sign in. */
  readonly secrets: Secrets | undefined;
  readonly audit: AuditService;
  readonly clock: Clock;
  /** Where redirect URIs point: always `PUBLIC_ORIGIN`, never the request's Host (threat model, T15). */
  readonly publicOrigin: string;
}

export const clientSecretAad = (id: string): EnvelopeAad => ({ table: "sso_providers", column: "client_secret", rowId: id });

/** The one place a provider's redirect URI is built: always on `PUBLIC_ORIGIN` (threat model, T15). */
export const ssoRedirectUri = (publicOrigin: string, providerId: string): string =>
  absoluteUrl({ publicOrigin }, ssoCallbackPath(providerId));

export function toProviderRecord(row: SsoProviderRow): SsoProviderRecord {
  return { id: row.id, kind: row.kind, name: row.name, issuer: row.issuer, enabled: row.enabled };
}

export function createSsoProvidersService({
  repository,
  protocol,
  secrets,
  audit,
  clock,
  publicOrigin,
}: SsoProvidersDependencies): SsoProvidersService {
  const requireSecrets = (): Secrets => {
    if (secrets === undefined) throw new Error("SSO providers need the master key");
    return secrets;
  };

  const toProvider = (row: SsoProviderRow, links: number): SsoProvider => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    issuer: row.issuer,
    clientId: row.clientId,
    clientSecretSet: row.clientSecret !== "",
    enabled: row.enabled,
    redirectUri: ssoRedirectUri(publicOrigin, row.id),
    linkedSignIns: links,
    createdAt: row.createdAt,
  });

  const viewOf = (id: string): SsoProvider => {
    const row = repository.findProvider(id);
    if (row === undefined) throw new HttpProblem(404, problemTypes.notFound);
    return toProvider(row, repository.linkCounts().get(id) ?? 0);
  };

  /** The admin's page chooses the id (to show the redirect URI before adding), so it is checked like the issuer. */
  const requireFreeId = (id: string): void => {
    if (repository.findProvider(id) !== undefined) throw new HttpProblem(409, problemTypes.ssoProviderIdTaken);
  };

  const requireFreeIssuer = (issuer: string, exceptId: string | null): void => {
    const holder = repository.findProviderByIssuer(issuer);
    if (holder !== undefined && holder.id !== exceptId) throw new HttpProblem(409, problemTypes.ssoIssuerTaken);
  };

  const checkIssuer = async (issuer: string): Promise<void> => {
    try {
      await protocol.checkIssuer(issuer);
    } catch (error) {
      if (error instanceof DiscoveryFailedError) {
        throw new HttpProblem(422, problemTypes.ssoDiscoveryFailed, "No OpenID Connect provider was found for this issuer.");
      }
      throw error;
    }
  };

  const record = (
    row: SsoProviderRow,
    change: AuditDetails<"sso-provider.changed">["change"],
    fields: ChangedField[],
    context: ActionContext,
  ) => {
    audit.record({
      action: "sso-provider.changed",
      actor: context.actor,
      outcome: "succeeded",
      target: { kind: "sso-provider", id: row.id },
      ...(context.origin === undefined ? {} : { origin: context.origin }),
      details: { change, kind: row.kind, name: row.name, fields },
    });
  };

  return {
    publicOrigin,

    list() {
      const counts = repository.linkCounts();
      return repository.listProviders().map((row) => toProvider(row, counts.get(row.id) ?? 0));
    },

    listForSignIn() {
      return repository
        .listProviders()
        .filter((row) => row.enabled)
        .map((row) => ({ id: row.id, kind: row.kind, name: row.name }));
    },

    find(id) {
      const row = repository.findProvider(id);
      return row === undefined ? undefined : toProviderRecord(row);
    },

    endpointOf(id) {
      const row = repository.findProvider(id);
      if (row === undefined) return undefined;
      return {
        ...toProviderRecord(row),
        clientId: row.clientId,
        clientSecret: requireSecrets().decrypt("sso", clientSecretAad(row.id), row.clientSecret),
      };
    },

    async add(provider, context) {
      const issuer = provider.kind === "oidc" ? provider.issuer : fixedIssuers[provider.kind];
      const id = provider.id ?? newId(clock);
      requireFreeId(id);
      requireFreeIssuer(issuer, null);
      if (provider.kind === "oidc") await checkIssuer(issuer);
      const now = clock.now().toISOString();
      const row: SsoProviderRow = {
        id,
        kind: provider.kind,
        name: provider.name,
        issuer,
        clientId: provider.clientId,
        clientSecret: requireSecrets().encrypt("sso", clientSecretAad(id), provider.clientSecret),
        enabled: provider.enabled,
        createdAt: now,
        updatedAt: now,
      };
      // Checked again here: discovery took a while, and another add may have taken the id or issuer meanwhile.
      requireFreeId(id);
      requireFreeIssuer(issuer, null);
      repository.insertProvider(row);
      record(row, "added", ["name", "issuer", "clientId", "clientSecret", "enabled"], context);
      return toProvider(row, 0);
    },

    async change(id, change, context) {
      const current = repository.findProvider(id);
      if (current === undefined) throw new HttpProblem(404, problemTypes.notFound);
      const issuerChanged = change.issuer !== undefined && change.issuer !== current.issuer;
      if (change.issuer !== undefined && current.kind !== "oidc") {
        throw new HttpProblem(422, problemTypes.validationFailed, "Only a generic OpenID Connect provider's issuer can change.");
      }
      if (issuerChanged && change.issuer !== undefined) {
        // Links match on (issuer, subject): a new issuer would leave every linked account unable to sign in.
        if ((repository.linkCounts().get(id) ?? 0) > 0) {
          throw new HttpProblem(409, problemTypes.ssoProviderInUse, "Accounts sign in with this provider, so its issuer can't change.");
        }
        // The client secret is sent to the issuer's token endpoint, so a saved one never goes to another issuer.
        if (change.clientSecret === undefined) {
          throw new HttpProblem(
            400,
            problemTypes.badRequest,
            "Enter the client secret again: a saved secret is never sent to another issuer.",
          );
        }
        requireFreeIssuer(change.issuer, id);
        await checkIssuer(change.issuer);
        requireFreeIssuer(change.issuer, id);
      }

      const fields: ChangedField[] = [];
      const update: ProviderChange = {};
      if (change.name !== undefined && change.name !== current.name) {
        fields.push("name");
        update.name = change.name;
      }
      if (issuerChanged && change.issuer !== undefined) {
        fields.push("issuer");
        update.issuer = change.issuer;
      }
      if (change.clientId !== undefined && change.clientId !== current.clientId) {
        fields.push("clientId");
        update.clientId = change.clientId;
      }
      // A typed secret always counts as changed: comparing it would mean decrypting the old one for nothing.
      if (change.clientSecret !== undefined) {
        fields.push("clientSecret");
        update.clientSecret = requireSecrets().encrypt("sso", clientSecretAad(id), change.clientSecret);
      }
      if (change.enabled !== undefined && change.enabled !== current.enabled) {
        fields.push("enabled");
        update.enabled = change.enabled;
      }
      if (fields.length === 0) return viewOf(id);
      repository.updateProvider(id, { ...update, updatedAt: clock.now().toISOString() });
      record({ ...current, ...update }, "changed", fields, context);
      return viewOf(id);
    },

    remove(id, context) {
      const current = repository.findProvider(id);
      if (current === undefined) throw new HttpProblem(404, problemTypes.notFound);
      if ((repository.linkCounts().get(id) ?? 0) > 0) {
        throw new HttpProblem(409, problemTypes.ssoProviderInUse, "Accounts sign in with this provider. Disable it instead.");
      }
      repository.deleteProvider(id);
      record(current, "removed", [], context);
    },
  };
}
