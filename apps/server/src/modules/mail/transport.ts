import type { SmtpTlsMode } from "@not-unreachable/contracts";
import { createTransport } from "nodemailer";

/** Connecting, the greeting and each socket silence give up after this. */
export const SMTP_TIMEOUT_MS = 10_000;

/** Everything a connection to the SMTP server needs, the password decrypted. */
export interface SmtpConnection {
  readonly host: string;
  readonly port: number;
  readonly tlsMode: SmtpTlsMode;
  readonly auth: { readonly username: string; readonly password: string } | null;
}

export interface MailMessage {
  readonly from: { readonly name: string; readonly address: string };
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
  close(): void;
}

/** Makes the transport for one send; tests may route it elsewhere. */
export type MailTransportFactory = (connection: SmtpConnection) => MailTransport;

/**
 * `starttls` refuses to go on without TLS; `tls` is TLS from the first byte; `none` never upgrades
 * (the service allows it for a loopback host only). Certificates are always verified (T6).
 */
export const nodemailerTransport: MailTransportFactory = (connection) => {
  const transport = createTransport({
    host: connection.host,
    port: connection.port,
    secure: connection.tlsMode === "tls",
    requireTLS: connection.tlsMode === "starttls",
    ignoreTLS: connection.tlsMode === "none",
    ...(connection.auth === null ? {} : { auth: { user: connection.auth.username, pass: connection.auth.password } }),
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  return {
    send: async (message) => {
      await transport.sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
    close: () => {
      transport.close();
    },
  };
};
