import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { CopyField, type CopyOutcome } from "../CopyField/index.ts";

export interface QrCodePanelProps {
  /** The QR code as an image URL, such as the SVG data URL the server draws; never fetched from another origin. */
  qrCode: string;
  /** The image's text alternative. */
  alt: string;
  /** The same secret as text, for an app that can't scan; shown in a CopyField. */
  setupKey: string;
  /**
   * The CopyField's label.
   * @defaultValue "Setup key"
   */
  setupKeyLabel?: string;
  /** A line under the QR code, such as which apps can scan it. */
  description?: React.ReactNode;
  /** Called after each copy of the setup key. */
  onCopy?: (outcome: CopyOutcome) => void;
  /** Classes for the wrapper. */
  className?: string;
}

/**
 * A QR code to scan with a phone, on a sunken panel, with the same secret as a setup key to type
 * in by hand. The image is an `<img>` of a URL the caller gives (a data URL drawn by the server),
 * so the package draws no QR code and loads nothing.
 *
 * @example
 * <QrCodePanel qrCode={enrolment.qrCode} alt="QR code for your authenticator app" setupKey={enrolment.setupKey} />
 */
export function QrCodePanel({ qrCode, alt, setupKey, setupKeyLabel = "Setup key", description, onCopy, className }: QrCodePanelProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex flex-col items-center gap-2 rounded-card border border-solid border-border bg-surface-sunken p-4">
        <img src={qrCode} alt={alt} width={160} height={160} className="size-40 rounded-badge" />
        {description != null && <p className="m-0 text-center type-caption text-fg-3">{description}</p>}
      </div>
      <CopyField label={setupKeyLabel} value={setupKey} {...(onCopy === undefined ? {} : { onCopy })} />
    </div>
  );
}
