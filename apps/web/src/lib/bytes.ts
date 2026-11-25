/** Bytes in a gigabyte, as quotas are typed: decimal, as disks are sold. */
export const BYTES_PER_GB = 1_000_000_000;

const byteUnits = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

const amount = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

/** "10 GB", "512 MB", "0 B": a size or a quota, in decimal units. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < byteUnits.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${amount.format(value)} ${byteUnits[unit] ?? "B"}`;
}
