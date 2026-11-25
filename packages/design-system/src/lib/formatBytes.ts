/** Decimal units, as disks are sold and as the web app types quotas. */
const byteUnits = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

const amount = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

/** The unit index a byte count is best shown in: 0 for B, 1 for KB … */
export function byteUnitOf(bytes: number): number {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < byteUnits.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit;
}

/** The number of bytes in a unit, without its name: `formatBytesIn(4_200_000_000, 3)` is "4.2". */
export function formatBytesIn(bytes: number, unit: number): string {
  return amount.format(Math.max(0, bytes) / 1000 ** unit);
}

/** "10 GB", "512 MB", "0 B": a size, in decimal units. */
export function formatBytes(bytes: number): string {
  const unit = byteUnitOf(bytes);
  return `${formatBytesIn(bytes, unit)} ${byteUnits[unit] ?? "B"}`;
}

/** "4.2 / 10 GB": an amount of a total, both in the total's unit. */
export function formatBytesOf(bytes: number, total: number): string {
  const unit = byteUnitOf(total);
  return `${formatBytesIn(bytes, unit)} / ${formatBytesIn(total, unit)} ${byteUnits[unit] ?? "B"}`;
}
