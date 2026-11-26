import { routes, type EntriesPage, type Entry } from "@not-unreachable/contracts";
import { api, buildPath, buildQuery } from "../api/index.ts";
import type { EntrySort } from "./sort.ts";
import type { UploadTarget } from "./upload-store.ts";

/**
 * What the file browser browses: the user's home, or one of the admin's resources. Each is the
 * same five operations over its own routes, so the browser itself knows neither.
 */
export interface FileSource {
  /** The prefix of every query key of this source; invalidated after a change. */
  readonly queryKey: readonly string[];
  /** A page of a folder's entries in `sort`; a `cursor` is only good with the sort it came with. */
  readonly list: (path: string, sort: EntrySort, cursor: string | undefined, signal: AbortSignal) => Promise<EntriesPage>;
  readonly createFolder: (path: string, name: string) => Promise<Entry>;
  readonly remove: (path: string, recursive: boolean) => Promise<void>;
  /** The download URL of a file: the server sends it as an attachment, with Range support. */
  readonly contentUrl: (path: string) => string;
  /** Where an upload into a folder goes. */
  readonly uploadTarget: (folder: string) => UploadTarget;
}

export const filesQueryKey = ["files"] as const;

function entriesQuery(path: string, sort: EntrySort, cursor: string | undefined) {
  return { path, sort: sort.key, order: sort.order, ...(cursor === undefined ? {} : { cursor }) };
}

/** The signed-in user's own home. */
export const homeSource: FileSource = {
  queryKey: [...filesQueryKey, "home"],
  list: (path, sort, cursor, signal) => api("listHomeEntries", { query: entriesQuery(path, sort, cursor), signal }),
  createFolder: (path, name) => api("createHomeFolder", { body: { path, name } }),
  remove: async (path, recursive) => {
    await api("deleteHomeEntry", { query: { path, recursive: String(recursive) } });
  },
  contentUrl: (path) => buildPath(routes.downloadHomeFile.path, {}) + buildQuery({ path }),
  uploadTarget: (folder) => ({ folder }),
};

/** One of the admin's resources, by its id. */
export function resourceSource(resourceId: string): FileSource {
  const params = { resourceId };
  return {
    queryKey: [...filesQueryKey, "resource", resourceId],
    list: (path, sort, cursor, signal) => api("listResourceEntries", { params, query: entriesQuery(path, sort, cursor), signal }),
    createFolder: (path, name) => api("createResourceFolder", { params, body: { path, name } }),
    remove: async (path, recursive) => {
      await api("deleteResourceEntry", { params, query: { path, recursive: String(recursive) } });
    },
    contentUrl: (path) => buildPath(routes.downloadResourceFile.path, params) + buildQuery({ path }),
    uploadTarget: (folder) => ({ folder, resourceId }),
  };
}
