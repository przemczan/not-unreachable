import type { ComboboxOption } from "@not-unreachable/design-system";
import type { Resource } from "@not-unreachable/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../api/index.ts";
import { resourceSource } from "../files/index.ts";

/** The most folders suggested at once; the admin types more of the name to narrow a bigger folder. */
export const FOLDER_SUGGESTIONS_MAX = 50;

/** A typed path split at its last `/`: the folder typed so far, and the start of a name in it. */
export interface TypedPath {
  /** The folder listed, as the server takes it: no leading, trailing or doubled `/`. */
  readonly parent: string;
  /** What the suggested names in `parent` start with. */
  readonly prefix: string;
}

export function splitTypedPath(typed: string): TypedPath {
  const lastSlash = typed.lastIndexOf("/");
  const parent = typed
    .slice(0, Math.max(lastSlash, 0))
    .split("/")
    .filter((segment) => segment !== "")
    .join("/");
  return { parent, prefix: typed.slice(lastSlash + 1) };
}

/** The names of every folder in `path`, read through every page. */
async function listFolderNames(resourceId: string, path: string, signal: AbortSignal): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await api("listResourceEntries", {
      params: { resourceId },
      query: { path, ...(cursor === undefined ? {} : { cursor }) },
      signal,
    });
    for (const entry of page.entries) if (entry.kind === "folder") names.push(entry.name);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return names;
}

export interface FolderSuggestions {
  readonly options: readonly ComboboxOption[];
  readonly loading: boolean;
}

const none: readonly ComboboxOption[] = [];

/**
 * The folders of a resource to suggest for a typed path: those in the folder typed so far whose name
 * starts with what follows its last `/`, each as the whole path ending in `/`, so choosing one goes
 * down into it. None for an unavailable resource, or a folder that is missing or refused: any path
 * can still be typed, and a missing one is created on save.
 */
export function useFolderSuggestions(resource: Resource | undefined, typed: string): FolderSuggestions {
  const { parent, prefix } = splitTypedPath(typed);
  const resourceId = resource?.state === "available" ? resource.id : undefined;
  const folders = useQuery({
    // Under the resource's files key, so a change made in Files refreshes these too.
    queryKey: [...resourceSource(resourceId ?? "").queryKey, "folder-names", parent],
    queryFn: ({ signal }) => listFolderNames(resourceId ?? "", parent, signal),
    enabled: resourceId !== undefined,
    retry: false,
  });
  const options = useMemo(() => {
    if (resourceId === undefined || folders.data === undefined) return none;
    const start = prefix.toLocaleLowerCase();
    return folders.data
      .filter((name) => name.toLocaleLowerCase().startsWith(start))
      .toSorted((first, second) => first.localeCompare(second))
      .slice(0, FOLDER_SUGGESTIONS_MAX)
      .map((name) => ({ value: `${parent === "" ? "" : `${parent}/`}${name}/`, label: name }));
  }, [resourceId, folders.data, parent, prefix]);
  return { options, loading: folders.isLoading };
}
