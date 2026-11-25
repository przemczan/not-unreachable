import type { AuditService } from "../audit/index.ts";
import type { Clock, Db, Logger, Secrets } from "../platform/index.ts";
import { createMailRepository } from "./repository.ts";
import { createMailServiceWith, type MailService } from "./service.ts";
import { nodemailerTransport, type MailTransportFactory } from "./transport.ts";

export { createMailHandlers, type FindAccountEmail, type MailRoutes } from "./routes.ts";
export {
  isLoopbackHost,
  MailNotConfiguredError,
  MailSendFailedError,
  smtpPasswordAad,
  type MailActionContext,
  type MailService,
  type NewMailSettings,
} from "./service.ts";
export { mailSettings, SMTP_SETTINGS_ID, type MailSettingsRow } from "./schema.ts";
export { type MailTemplate } from "./templates.ts";
export { SMTP_TIMEOUT_MS, type MailMessage, type MailTransport, type MailTransportFactory, type SmtpConnection } from "./transport.ts";

export interface MailDependencies {
  readonly db: Db;
  readonly clock: Clock;
  readonly audit: AuditService;
  /** The master key's secrets; the CLI has none, so it can't store or use an SMTP password. */
  readonly secrets: Secrets | undefined;
  /** `PUBLIC_ORIGIN`, which every link in an email is built from (threat model, T15). */
  readonly publicOrigin: string;
  readonly logger: Logger;
  /** Nodemailer unless given; tests route it elsewhere. */
  readonly transport?: MailTransportFactory;
}

export function createMailService({ db, transport, ...rest }: MailDependencies): MailService {
  return createMailServiceWith({ repository: createMailRepository(db), transport: transport ?? nodemailerTransport, ...rest });
}
