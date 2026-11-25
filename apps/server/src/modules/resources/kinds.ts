import type {
  FolderRefusal,
  NewResource,
  Resource,
  ResourceChange,
  ResourceCheck,
  ResourceCheckRequest,
  ResourceKind,
  ShareFailure,
  UnavailableReason,
} from "@not-unreachable/contracts";
import type { AuditDetails } from "../audit/index.ts";
import type { RealPath } from "../storage/index.ts";
import type { ResourceRow } from "./schema.ts";

/** The columns every kind shares; a kind owns the rest of the row. */
type CommonColumns =
  "id" | "name" | "kind" | "rootRealpath" | "isHomeRoot" | "homeRootSubpath" | "state" | "unavailableReason" | "createdAt";

/** The kind's own columns, as it stores them. */
export type KindColumns = Partial<Omit<ResourceRow, CommonColumns>>;

/** The fields of a resource the API shows that only its kind knows; one branch per kind. */
export type KindFields<K extends ResourceKind = ResourceKind> = K extends ResourceKind
  ? Omit<Extract<Resource, { kind: K }>, "id" | "name" | "state" | "unavailableReason" | "isHomeRoot" | "createdAt">
  : never;

/** A field name `resource.changed` records. */
export type ResourceChangedField = AuditDetails<"resource.changed">["fields"][number];

/** A folder the service can't use, with the command that fixes it where there is one. */
export interface FolderKindRefusal {
  readonly ok: false;
  readonly reason: FolderRefusal;
  readonly command: string | null;
  /** For `not-writable` only: the admin can allow the folder from the admin interface instead. */
  readonly allowFromUi: boolean;
}

/** A share that didn't mount. */
export interface ShareKindRefusal {
  readonly ok: false;
  readonly reason: ShareFailure;
  readonly command: null;
  readonly allowFromUi: false;
}

/** Why new settings were refused. */
export type KindRefusal = FolderKindRefusal | ShareKindRefusal;

/** New settings, checked: the root's real path and the columns to store. */
export type PreparedSettings = { readonly ok: true; readonly realPath: RealPath; readonly columns: KindColumns } | KindRefusal;

/** A change, checked: the kind's fields it changes (none for a no-op) and what to store. */
export type PreparedChange =
  | {
      readonly ok: true;
      readonly fields: readonly ResourceChangedField[];
      readonly realPath: RealPath;
      readonly columns: KindColumns;
    }
  | { readonly ok: true; readonly fields: readonly [] }
  | KindRefusal;

export type Activation = { readonly ok: true; readonly realPath: RealPath } | { readonly ok: false; readonly reason: UnavailableReason };

/**
 * One kind of resource. The service calls it and never looks at `kind` itself, so a new kind is a
 * new definition, a contract branch and its columns: no change to the service, storage or files.
 */
export interface ResourceKindDefinition<K extends ResourceKind = ResourceKind> {
  readonly kind: K;
  /** Checks a new resource's settings (add), for the resource `id` it will be saved as. */
  prepare(input: Extract<NewResource, { kind: K }>, id: string): Promise<PreparedSettings>;
  /** Checks a change of the kind's own fields against the stored row (change). */
  prepareChange(row: ResourceRow, change: Extract<ResourceChange, { kind: K }>): Promise<PreparedChange>;
  /** Startup and Retry: the root is reachable and is still the real path stored (else `changed`). */
  activate(row: ResourceRow): Promise<Activation>;
  /** On remove, or when an add that `prepare` accepted isn't saved after all; never deletes anything on disk. */
  deactivate(id: string): Promise<void>;
  /** "Check folder" or "Test connection": whether `prepare` would accept the settings; keeps nothing. */
  test(input: Extract<ResourceCheckRequest, { kind: K }>): Promise<ResourceCheck>;
  /** After every row of the kind was activated at startup. */
  onStartup(rows: readonly ResourceRow[]): Promise<void>;
  /** The unavailable resources whose next automatic retry is due now; none for a kind that never retries. */
  dueForRetry(): readonly string[];
  /** The kind's fields of the API's resource; never a secret. */
  present(row: ResourceRow): KindFields<K>;
}

export type ResourceKindRegistry = { readonly [K in ResourceKind]: ResourceKindDefinition<K> };

/** The definition of a row's or a request's kind. */
export function definitionOf(registry: ResourceKindRegistry, kind: ResourceKind): ResourceKindDefinition {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- each entry is its own kind's definition, and the service hands it only rows and requests of that kind.
  return registry[kind] as ResourceKindDefinition;
}
