import { useSyncExternalStore } from "react";
import type { UploadRecord, UploadStore } from "./upload-store.ts";

/** The store's uploads, re-rendering on every change. */
export function useUploads(store: UploadStore): readonly UploadRecord[] {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
