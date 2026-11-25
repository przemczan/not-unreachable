import { invitationPath, relinkPath } from "@not-unreachable/contracts";
import { absoluteUrl } from "../platform/index.ts";

/** What the other modules ask the mail module to send. */
export type MailTemplate =
  | { readonly kind: "invitation"; readonly token: string; readonly expiresAt: string }
  | { readonly kind: "relink"; readonly token: string; readonly expiresAt: string; readonly username: string }
  | { readonly kind: "test" }
  | { readonly kind: "security-notice"; readonly subject: string; readonly text: string }
  /** An update from Settings succeeded (a security notice, threat model T10 and T17). */
  | { readonly kind: "update-succeeded"; readonly version: string; readonly at: string }
  /**
   * An update from Settings was rolled back, or its rollback failed (an alert). `reason` is the
   * reason's words, never anything the release or GitHub sent.
   */
  | {
      readonly kind: "update-rolled-back";
      readonly result: "rolled-back" | "rollback-failed";
      readonly from: string;
      readonly to: string;
      readonly reason: string;
    };

export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export const PRODUCT_NAME = "NotUnreachable";

const htmlEscapes: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Every interpolated value goes through this: a username or subject must never become markup. */
export const escapeHtml = (value: string): string => value.replaceAll(/[&<>"']/g, (character) => htmlEscapes[character] ?? character);

function readableTime(iso: string): string {
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? iso : `${time.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

interface Body {
  readonly heading: string;
  /** Plain paragraphs, each escaped for the HTML. */
  readonly paragraphs: readonly string[];
  readonly link?: { readonly label: string; readonly url: string };
}

function renderBody(subject: string, { heading, paragraphs, link }: Body): RenderedMail {
  const text = [heading, ...paragraphs, ...(link === undefined ? [] : [`${link.label}: ${link.url}`]), `-- ${PRODUCT_NAME}`].join("\n\n");
  const html = [
    `<h1>${escapeHtml(heading)}</h1>`,
    ...paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    ...(link === undefined ? [] : [`<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`]),
    `<p>${PRODUCT_NAME}</p>`,
  ].join("\n");
  return { subject, text: `${text}\n`, html: `<!doctype html><html><body>\n${html}\n</body></html>\n` };
}

/** Links are absolute and built from `PUBLIC_ORIGIN` only (threat model, T15). */
export function renderMail(template: MailTemplate, publicOrigin: string): RenderedMail {
  if (template.kind === "invitation") {
    return renderBody(`You're invited to ${PRODUCT_NAME}`, {
      heading: `You're invited to ${PRODUCT_NAME}`,
      paragraphs: [`Use this link to set up your account. It works until ${readableTime(template.expiresAt)}.`],
      link: { label: "Accept the invitation", url: absoluteUrl({ publicOrigin }, invitationPath(template.token)) },
    });
  }
  if (template.kind === "relink") {
    return renderBody(`Sign in again to ${PRODUCT_NAME}`, {
      heading: `Sign in again to ${PRODUCT_NAME}`,
      paragraphs: [
        `Use this link to sign in with a new provider as ${template.username}. It works until ${readableTime(template.expiresAt)}.`,
      ],
      link: { label: "Sign in with a new provider", url: absoluteUrl({ publicOrigin }, relinkPath(template.token)) },
    });
  }
  if (template.kind === "test") {
    return renderBody(`${PRODUCT_NAME} test email`, {
      heading: "Email works",
      paragraphs: [`This is a test email from ${PRODUCT_NAME}. Email is set up correctly.`],
    });
  }
  if (template.kind === "update-succeeded") {
    const heading = `${PRODUCT_NAME} was updated to ${template.version} from Settings`;
    return renderBody(`${PRODUCT_NAME}: ${heading}`, {
      heading,
      paragraphs: [
        `The admin interface installed ${PRODUCT_NAME} ${template.version} at ${readableTime(template.at)}, after the admin's password and second factor.`,
        "If this wasn't you, sign in, change your password and check the audit log; then turn installing from Settings off on the server with sudo not-unreachable update-from-ui off.",
      ],
    });
  }
  if (template.kind === "update-rolled-back") {
    if (template.result === "rollback-failed") {
      const heading = `The update to ${template.to} failed, and so did the rollback`;
      return renderBody(`${PRODUCT_NAME}: ${heading}`, {
        heading,
        paragraphs: [
          `The update from ${template.from} to ${template.to} didn't work (${template.reason}), and ${template.from} didn't come back either, so the service stayed down until it was repaired over SSH.`,
          "Check that the service runs as expected, and follow Upgrade and rollback in the install guide if it doesn't.",
        ],
      });
    }
    const heading = `The update to ${template.to} was rolled back`;
    return renderBody(`${PRODUCT_NAME}: ${heading}`, {
      heading,
      paragraphs: [
        `The update from ${template.from} to ${template.to} didn't work (${template.reason}), so it was rolled back.`,
        `The server runs ${template.from} again, with its data as it was before the update.`,
      ],
    });
  }
  return renderBody(`${PRODUCT_NAME}: ${template.subject}`, { heading: template.subject, paragraphs: [template.text] });
}
