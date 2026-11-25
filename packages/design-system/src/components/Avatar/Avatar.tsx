import { cva } from "class-variance-authority";
import { cn } from "../../lib/cn.ts";

const avatarVariants = cva("inline-grid flex-none place-items-center overflow-hidden rounded-full", {
  variants: {
    size: {
      xs: "size-5 type-caption",
      sm: "size-6 type-caption",
      md: "size-8 type-caption",
      lg: "size-10 type-body",
      xl: "size-14 type-section-title",
    },
  },
  defaultVariants: { size: "md" },
});

/**
 * The initials' colours, picked by the name's hash: the source's blue, green, amber, ember, gray
 * and red ramps (100 fill, 700 text), as the semantic subtle/fg pairs closest to them.
 */
const palette = [
  "bg-info-subtle text-info-fg",
  "bg-success-subtle text-success-fg",
  "bg-warning-subtle text-warning-fg",
  "bg-accent-subtle text-accent-subtle-fg",
  "bg-neutral-subtle text-neutral-fg",
  "bg-danger-subtle text-danger-fg",
] as const;

/** Up to two initials, from the first two words of the name. */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

/** The same name always gets the same colour. */
export function paletteIndexOf(name: string): number {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % palette.length;
}

export interface AvatarProps {
  /** Full name: the initials, the colour and the accessible name are derived from it. */
  name?: string;
  /** Image URL; without it the avatar shows the initials. */
  src?: string;
  /**
   * Diameter: `xs` 20px, `sm` 24px, `md` 32px, `lg` 40px, `xl` 56px.
   * @defaultValue "md"
   */
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
}

/**
 * A circular user avatar, with a deterministic initials fallback; for user tables, the audit log
 * and the topbar.
 *
 * @example
 * <Avatar name="Marta Kowalska" size="sm" />
 */
export function Avatar({ name = "", src, size = "md", className }: AvatarProps) {
  const labelled = name.trim() !== "";
  return (
    <span
      role={labelled ? "img" : undefined}
      aria-label={labelled ? name : undefined}
      aria-hidden={labelled ? undefined : true}
      title={labelled ? name : undefined}
      className={cn(avatarVariants({ size }), src ? "bg-neutral-subtle" : palette[paletteIndexOf(name)], className)}
    >
      {src ? (
        <img src={src} alt="" className="size-full object-cover" />
      ) : (
        <span aria-hidden="true" className="font-semibold">
          {initialsOf(name)}
        </span>
      )}
    </span>
  );
}
