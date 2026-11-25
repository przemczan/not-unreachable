import { isIP } from "node:net";
import {
  problemTypes,
  type MailSettings,
  type SmtpTlsMode,
  type TestEmailSent,
  type updateMailSettingsRequestSchema,
} from "@not-unreachable/contracts";
import type { z } from "zod";
import { HttpProblem } from "../../http/index.ts";
import type { AuditActor, AuditDetails, AuditOrigin, AuditService } from "../audit/index.ts";
import type { Clock, EnvelopeAad, Logger, Secrets } from "../platform/index.ts";
import type { MailRepository } from "./repository.ts";
import { SMTP_SETTINGS_ID, type MailSettingsRow } from "./schema.ts";
import { PRODUCT_NAME, renderMail, type MailTemplate } from "./templates.ts";
import type { MailTransportFactory, SmtpConnection } from "./transport.ts";

export type NewMailSettings = z.output<typeof updateMailSettingsRequestSchema>;
type ChangedField = Extract<AuditDetails<"settings.changed">, { setting: "mail" }>["fields"][number];

/** Nothing is emailed until the admin has set SMTP up. */
export class MailNotConfiguredError extends Error {
  override readonly name = "MailNotConfiguredError";
  constructor() {
    super("SMTP is not set up");
  }
}

/** The server refused the message or couldn't be reached. The message never holds the password. */
export class MailSendFailedError extends Error {
  override readonly name = "MailSendFailedError";
}

/** Who acts, and from where, for the audit log. */
export interface MailActionContext {
  readonly actor: AuditActor;
  readonly origin?: AuditOrigin;
}

export interface MailService {
  isConfigured(): boolean;
  /** Renders the template (plain text and HTML) and sends it. Throws `MailNotConfiguredError` or `MailSendFailedError`. */
  send(template: MailTemplate, to: string): Promise<void>;
  getSettings(): MailSettings;
  /**
   * Replaces the settings. A left-out password keeps the stored one; a null username drops it.
   * 422 `validationFailed` for no TLS on a host that isn't loopback. Records `settings.changed`
   * with the fields that changed, never the password.
   */
  updateSettings(request: NewMailSettings, context: MailActionContext): MailSettings;
  /** Records `mail.test-sent`, succeeded or failed. */
  sendTest(to: string, context: MailActionContext): Promise<TestEmailSent>;
}

export interface MailDependencies {
  readonly repository: MailRepository;
  readonly clock: Clock;
  readonly audit: AuditService;
  /** The CLI has none, so it can't store or use a password. */
  readonly secrets: Secrets | undefined;
  /** `PUBLIC_ORIGIN`: every link in an email is built from it (threat model, T15). */
  readonly publicOrigin: string;
  readonly logger: Logger;
  readonly transport: MailTransportFactory;
}

export const smtpPasswordAad: EnvelopeAad = { table: "mail_settings", column: "password", rowId: SMTP_SETTINGS_ID };

/** `localhost`, 127.0.0.0/8 and ::1: the only hosts that may go without TLS (threat model, T6). */
export function isLoopbackHost(host: string): boolean {
  const name = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (name === "localhost" || name === "::1") return true;
  return isIP(name) === 4 && name.startsWith("127.");
}

function viewOf(row: MailSettingsRow | undefined): MailSettings {
  if (row === undefined) return { smtp: null };
  return {
    smtp: {
      host: row.host,
      port: row.port,
      tlsMode: row.tlsMode,
      username: row.username,
      passwordSet: row.password !== null,
      fromAddress: row.fromAddress,
      updatedAt: row.updatedAt,
    },
  };
}

function changedFields(current: MailSettingsRow | undefined, next: MailSettingsRow, passwordTyped: boolean): ChangedField[] {
  const fields: ChangedField[] = [];
  if (current?.host !== next.host) fields.push("host");
  if (current?.port !== next.port) fields.push("port");
  if (current?.tlsMode !== next.tlsMode) fields.push("tlsMode");
  if ((current?.username ?? null) !== next.username) fields.push("username");
  // A typed password counts as changed: comparing it would mean decrypting the old one for nothing.
  if (passwordTyped || (current?.password ?? null) !== next.password) fields.push("password");
  if (current?.fromAddress !== next.fromAddress) fields.push("fromAddress");
  return fields;
}

/** TLS is required unless the server is on this machine (threat model, T6). */
function requireTls(host: string, tlsMode: SmtpTlsMode): void {
  if (tlsMode === "none" && !isLoopbackHost(host)) {
    throw new HttpProblem(422, problemTypes.validationFailed, "Email without TLS is allowed only for a server on this machine.");
  }
}

export function createMailServiceWith({
  repository,
  clock,
  audit,
  secrets,
  publicOrigin,
  logger,
  transport,
}: MailDependencies): MailService {
  const requireSecrets = (): Secrets => {
    if (secrets === undefined) throw new Error("Mail settings need the master key");
    return secrets;
  };

  const connectionOf = (row: MailSettingsRow): SmtpConnection => ({
    host: row.host,
    port: row.port,
    tlsMode: row.tlsMode,
    auth:
      row.username === null || row.password === null
        ? null
        : { username: row.username, password: requireSecrets().decrypt("smtp", smtpPasswordAad, row.password) },
  });

  const send = async (template: MailTemplate, to: string): Promise<void> => {
    const row = repository.find();
    if (row === undefined) throw new MailNotConfiguredError();
    const rendered = renderMail(template, publicOrigin);
    const mail = transport(connectionOf(row));
    try {
      await mail.send({ from: { name: PRODUCT_NAME, address: row.fromAddress }, to, ...rendered });
    } catch (error) {
      // Only the codes: a server's own text could echo what was sent, such as the credentials.
      const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
      logger.warn({ code, host: row.host, port: row.port }, "sending an email failed");
      throw new MailSendFailedError(`The email server could not take the message (${code}).`);
    } finally {
      mail.close();
    }
  };

  const recordTest = (outcome: "succeeded" | "failed", context: MailActionContext): void => {
    audit.record({
      action: "mail.test-sent",
      actor: context.actor,
      outcome,
      ...(context.origin === undefined ? {} : { origin: context.origin }),
      details: {},
    });
  };

  return {
    isConfigured: () => repository.find() !== undefined,
    send,
    getSettings: () => viewOf(repository.find()),

    updateSettings(request, context) {
      requireTls(request.host, request.tlsMode);
      const current = repository.find();
      const passwordTyped = request.username !== null && request.password !== undefined;
      let password: string | null = null;
      if (request.username !== null) {
        if (request.password === undefined && current?.password != null && current.host !== request.host) {
          // A saved password goes only to the server it was typed for, so a session can't send it to its own (T6).
          throw new HttpProblem(
            400,
            problemTypes.badRequest,
            "Enter the password again: a saved password is never sent to another server.",
          );
        }
        password =
          request.password === undefined
            ? (current?.password ?? null)
            : requireSecrets().encrypt("smtp", smtpPasswordAad, request.password);
      }
      const row: MailSettingsRow = {
        id: SMTP_SETTINGS_ID,
        host: request.host,
        port: request.port,
        tlsMode: request.tlsMode,
        username: request.username,
        password,
        fromAddress: request.fromAddress,
        updatedAt: clock.now().toISOString(),
      };
      const fields = changedFields(current, row, passwordTyped);
      if (fields.length === 0) return viewOf(current);
      repository.save(row);
      audit.record({
        action: "settings.changed",
        actor: context.actor,
        outcome: "succeeded",
        ...(context.origin === undefined ? {} : { origin: context.origin }),
        details: { setting: "mail", fields },
      });
      return viewOf(row);
    },

    async sendTest(to, context) {
      try {
        await send({ kind: "test" }, to);
      } catch (error) {
        if (error instanceof MailSendFailedError) recordTest("failed", context);
        throw error;
      }
      recordTest("succeeded", context);
      return { sentTo: to };
    },
  };
}
