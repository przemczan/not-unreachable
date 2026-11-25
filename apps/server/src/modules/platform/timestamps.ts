/** A UTC timestamp safe in file names that sorts in time order, e.g. `20261124T101500123Z`. */
export function fileTimestamp(date: Date): string {
  return date.toISOString().replaceAll(/[-:.]/g, "");
}

export const FILE_TIMESTAMP_PATTERN = "\\d{8}T\\d{9}Z";
