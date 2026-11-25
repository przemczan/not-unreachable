/**
 * NotUnreachable's mark: a lowercase "nu" drawn as one unbroken route that climbs, dips and ends at
 * a node, in the accent colour on a rounded square. Drawn on a 32-unit grid; `<Logo />` and the
 * static files in this folder (written by scripts/render-brand-icons.ts) all draw it from here.
 */
export interface MarkCut {
  /** The route: one open path, stroked with round caps and joins. */
  readonly route: string;
  readonly routeWidth: number;
  /** The node the route ends at: a filled circle. */
  readonly node: { readonly cx: number; readonly cy: number; readonly r: number };
}

export const MARK_VIEW_BOX = "0 0 32 32";

/** The square's corner radius on the 32-unit grid: radius-control (6px) at 32px. */
export const MARK_CORNER_RADIUS = 6;

/** The mark as screens and the lockup show it, 20px and up. */
export const markCut: MarkCut = {
  route: "M6 26V14a5 5 0 0 1 10 0v4a5 5 0 0 0 10 0v-5",
  routeWidth: 3.5,
  node: { cx: 26, cy: 6, r: 3 },
};

/** The favicon's cut: a bolder route and node, so the three stems stay apart at 16px. */
export const faviconCut: MarkCut = {
  route: "M6 26.5V14a5 5 0 0 1 10 0v4a5 5 0 0 0 10 0v-4.5",
  routeWidth: 4,
  node: { cx: 26, cy: 6, r: 3.25 },
};
