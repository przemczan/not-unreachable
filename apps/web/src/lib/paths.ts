import type { EntryKind } from "@not-unreachable/contracts";
import type { IconName } from "@not-unreachable/design-system";

/** A path's segments: "" is the top folder, with none. */
export function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

/** The path of an entry in a folder. */
export function joinPath(folder: string, name: string): string {
  return [...segmentsOf(folder), name].join("/");
}

/** The URL of a folder under a page: `/files?path=Photos/2026`, or the page itself for the top folder. */
export function folderHref(page: string, path: string): string {
  if (path === "") return page;
  return `${page}?path=${encodeURIComponent(path).replaceAll("%2F", "/")}`;
}

const iconsByExtension: ReadonlyMap<string, IconName> = new Map(
  (
    [
      ["file-image", ["png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "svg", "bmp", "tif", "tiff"]],
      ["file-video-camera", ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv"]],
      ["file-music", ["mp3", "flac", "wav", "ogg", "m4a", "aac", "opus"]],
      ["file-archive", ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst"]],
      [
        "file-code",
        ["js", "ts", "tsx", "jsx", "json", "html", "css", "py", "sh", "go", "rs", "java", "c", "cpp", "h", "yml", "yaml", "xml"],
      ],
      ["file-spreadsheet", ["csv", "tsv", "xls", "xlsx", "ods", "numbers"]],
      ["file-text", ["txt", "md", "pdf", "doc", "docx", "odt", "rtf", "pages", "epub"]],
    ] as const
  ).flatMap(([icon, extensions]) => extensions.map((extension) => [extension, icon] as const)),
);

/** The file-type icon of a listing's entry. */
export function iconOf(kind: EntryKind, name: string): IconName {
  if (kind === "folder") return "folder";
  if (kind === "link") return "link";
  const dot = name.lastIndexOf(".");
  if (kind !== "file" || dot <= 0) return "file";
  return iconsByExtension.get(name.slice(dot + 1).toLowerCase()) ?? "file";
}
