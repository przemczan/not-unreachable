import { execFile } from "node:child_process";
import type { Logger } from "./logger.ts";

export interface NotifyOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly logger: Logger;
  /** The program that sends the notification; tests pass a fake. */
  readonly command?: string;
  readonly args?: readonly string[];
}

/**
 * Tells systemd (`Type=notify`) the service is ready. Node can't send AF_UNIX datagrams without a
 * native module, so this runs `systemd-notify --ready` (which needs `NotifyAccess=all`). Without
 * `NOTIFY_SOCKET` it does nothing. A failure is logged, never thrown: the service runs either way.
 */
export async function notifyReady({ environment, logger, command = "systemd-notify", args = ["--ready"] }: NotifyOptions): Promise<void> {
  const socket = environment["NOTIFY_SOCKET"];
  if (socket === undefined || socket === "") return;
  await new Promise<void>((resolve) => {
    execFile(command, [...args], { env: { ...environment, NOTIFY_SOCKET: socket }, timeout: 5_000, shell: false }, (error) => {
      if (error !== null) logger.warn({ err: error, command }, "Could not notify systemd that the service is ready");
      resolve();
    });
  });
}
