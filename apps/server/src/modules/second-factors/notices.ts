import type { MailService } from "../mail/index.ts";
import type { Logger } from "../platform/index.ts";

/** What the account holder should hear about at once, outside the app (threat model, T10). */
export type SecurityNotice =
  | { readonly kind: "recovery-code-used"; readonly accountId: string; readonly remaining: number }
  | { readonly kind: "second-factor-added" | "second-factor-removed"; readonly accountId: string }
  | { readonly kind: "second-factor-locked"; readonly accountId: string }
  /** The service can now write to this folder, allowed from the admin interface by the account. */
  | { readonly kind: "folder-allowed"; readonly accountId: string; readonly path: string };

/**
 * Where security notices go: `createMailedNotices` emails them once SMTP is set up; otherwise
 * each notice is in the audit log only, which the caller records anyway.
 */
export interface SecurityNotices {
  notify(notice: SecurityNotice): void;
}

export const auditOnlyNotices: SecurityNotices = { notify: () => undefined };

export interface MailedNoticesDependencies {
  readonly mail: Pick<MailService, "isConfigured" | "send">;
  /** The account holder's address, or null when the account has none. */
  readonly findAccountEmail: (accountId: string) => string | null;
  readonly logger: Logger;
}

type NoticeWording = { readonly subject: string; readonly text: string };

const IF_NOT_YOU = "If this wasn't you, sign in and change your password.";

const fixedWordings: Readonly<Record<Exclude<SecurityNotice["kind"], "recovery-code-used" | "folder-allowed">, NoticeWording>> = {
  "second-factor-added": {
    subject: "A second factor was added",
    text: `A second factor was added to your account. ${IF_NOT_YOU}`,
  },
  "second-factor-removed": {
    subject: "A second factor was removed",
    text: `A second factor was removed from your account. ${IF_NOT_YOU}`,
  },
  "second-factor-locked": {
    subject: "Too many wrong second-factor codes",
    text: "Someone entered too many wrong codes while signing in to your account, so that sign-in was stopped. If this wasn't you, change your password.",
  },
};

function wording(notice: SecurityNotice): NoticeWording {
  if (notice.kind === "recovery-code-used") {
    return {
      subject: `A recovery code was used - ${notice.remaining} left`,
      text: `One of your recovery codes was used to sign in. ${notice.remaining} are left. ${IF_NOT_YOU}`,
    };
  }
  if (notice.kind === "folder-allowed") {
    return {
      subject: "A folder was allowed",
      text: `The service can now write to the folder ${notice.path}, allowed from the admin interface, and restarted to apply it. ${IF_NOT_YOU}`,
    };
  }
  return fixedWordings[notice.kind];
}

/**
 * Emails the account holder once SMTP is set up. Fire and forget: a mail failure is logged and
 * never reaches the action that raised the notice, which the audit log records anyway.
 */
export function createMailedNotices({ mail, findAccountEmail, logger }: MailedNoticesDependencies): SecurityNotices {
  return {
    notify(notice) {
      if (!mail.isConfigured()) return;
      const to = findAccountEmail(notice.accountId);
      if (to === null) return;
      mail.send({ kind: "security-notice", ...wording(notice) }, to).catch((error: unknown) => {
        logger.warn(
          { kind: notice.kind, accountId: notice.accountId, err: error instanceof Error ? error.message : "unknown" },
          "a security notice could not be emailed",
        );
      });
    },
  };
}
