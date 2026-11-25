import { SMTPServer } from "smtp-server";

export interface ReceivedMail {
  readonly from: string;
  readonly to: string[];
  /** The whole message as sent, with its transfer encoding undone. */
  readonly raw: string;
}

export interface FakeSmtp {
  readonly port: number;
  readonly received: ReceivedMail[];
  close(): Promise<void>;
}

/** Undoes quoted-printable, which nodemailer uses for long lines, so a test can look for a link. */
const decodeQuotedPrintable = (text: string): string =>
  text.replaceAll(/=\r?\n/g, "").replaceAll(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

export interface FakeSmtpOptions {
  /** Hides STARTTLS from the greeting, as a server without TLS does. */
  readonly hideStartTls?: boolean;
}

/** An SMTP server on 127.0.0.1 and an ephemeral port, without TLS, that keeps what it is sent. */
export async function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const received: ReceivedMail[] = [];
  const server = new SMTPServer({
    authOptional: true,
    hideSTARTTLS: options.hideStartTls ?? true,
    logger: false,
    onData(stream, session, done) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        received.push({
          from: session.envelope.mailFrom === false ? "" : session.envelope.mailFrom.address,
          to: session.envelope.rcptTo.map((recipient) => recipient.address),
          raw: decodeQuotedPrintable(Buffer.concat(chunks).toString("utf8")),
        });
        done();
      });
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.server.address();
  if (address === null || typeof address === "string") throw new Error("The fake SMTP server has no port");
  return {
    port: address.port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
