import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Icon } from "../Icon/index.ts";

export interface DropZoneProps {
  /** Called with the dropped files (folders and other items are left out). */
  onFiles: (files: File[]) => void;
  /**
   * The overlay's title, which also names it for screen readers.
   * @defaultValue "Drop files to upload"
   */
  label?: string;
  /** A line under the title: where the files go, "Into Photos / 2026". */
  description?: React.ReactNode;
  /**
   * Ignores drags: no overlay, and the browser's default for a drop.
   * @defaultValue false
   */
  disabled?: boolean;
  className?: string;
}

/** True when the drag carries files, not text or a link. */
function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types !== undefined && Array.from(types).includes("Files");
}

/**
 * A full-page overlay while files are dragged over the window; dropping them anywhere calls
 * `onFiles`. Mount it once on a page that takes uploads; it renders nothing until a drag starts.
 *
 * @example
 * <DropZone onFiles={(files) => uploads.add(files, folder)} description="Into Photos" />
 */
export function DropZone({ onFiles, label = "Drop files to upload", description, disabled = false, className }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  useEffect(() => {
    depth.current = 0;
    if (disabled) return undefined;
    const onDragEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Cancelling dragover is what lets the window take the drop.
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onFilesRef.current(files);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      setDragging(false);
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [disabled]);

  if (!dragging || disabled) return null;
  return (
    <section
      aria-label={label}
      className={cn("pointer-events-none fixed inset-0 z-modal grid place-items-center bg-overlay p-page", className)}
    >
      <div className="flex size-full flex-col items-center justify-center gap-3 rounded-dialog border-2 border-dashed border-accent bg-surface-raised text-center shadow-floating">
        <span className="grid size-10 place-items-center rounded-card bg-accent-subtle text-accent-subtle-fg">
          <Icon name="upload" size={20} />
        </span>
        <p className="m-0 type-section-title text-fg-1">{label}</p>
        {description != null && <p className="m-0 type-body text-fg-2">{description}</p>}
      </div>
    </section>
  );
}
