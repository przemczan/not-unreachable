import { entrySortKeys, sortOrders, type EntrySortKey, type SortOrder } from "@not-unreachable/contracts";
import { useState } from "react";
import { z } from "zod";

/** The order the file browser lists a folder in; folders always come first, whatever it is. */
export interface EntrySort {
  readonly key: EntrySortKey;
  readonly order: SortOrder;
}

/** Name, A→Z: with nothing remembered, or something unreadable. */
export const defaultEntrySort: EntrySort = { key: "name", order: "asc" };

/**
 * The one sort of every file browser, home and resources alike, so it holds from folder to folder
 * and across reloads. Anything in storage may have been changed, so it is checked when read.
 */
export const entrySortStorageKey = "file-browser-sort";

const sortKeySchema = z.enum(entrySortKeys);
const entrySortSchema = z.object({ key: sortKeySchema, order: z.enum(sortOrders) });

/** The order a column starts in when it is picked: names A→Z, the largest and the newest first. */
const firstOrders: Record<EntrySortKey, SortOrder> = { name: "asc", size: "desc", modified: "desc" };

/** The sort after a click on a column's header: the sorted column flips, another starts in its first order. */
export function nextEntrySort(current: EntrySort, key: EntrySortKey): EntrySort {
  if (current.key !== key) return { key, order: firstOrders[key] };
  return { key, order: current.order === "asc" ? "desc" : "asc" };
}

export function readEntrySort(): EntrySort {
  try {
    const stored = localStorage.getItem(entrySortStorageKey);
    if (stored === null) return defaultEntrySort;
    const parsed = entrySortSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : defaultEntrySort;
  } catch {
    // Storage is refused (private mode), or holds no JSON.
    return defaultEntrySort;
  }
}

export function saveEntrySort(sort: EntrySort): void {
  try {
    localStorage.setItem(entrySortStorageKey, JSON.stringify({ key: sort.key, order: sort.order }));
  } catch {
    // Storage is refused (private mode, quota): the sort lasts until the page is left.
  }
}

/** The remembered sort, and what a click on a column's header (by the column's key) does to it. */
export function useEntrySort(): readonly [EntrySort, (columnKey: string) => void] {
  const [sort, setSort] = useState(readEntrySort);
  const sortBy = (columnKey: string) => {
    const key = sortKeySchema.safeParse(columnKey);
    if (!key.success) return;
    const next = nextEntrySort(sort, key.data);
    setSort(next);
    saveEntrySort(next);
  };
  return [sort, sortBy];
}
