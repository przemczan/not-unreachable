import type { Logger } from "./modules/platform/index.ts";

/** The part of `process` the handlers attach to; tests hand in an EventEmitter. */
export interface ProcessErrorEvents {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  on(event: "uncaughtException", listener: (error: Error) => void): unknown;
}

export interface ProcessErrorHandling {
  readonly logger: Pick<Logger, "error" | "fatal">;
  /** Ends the process; `process.exit` outside tests. */
  readonly exit: (code: number) => void;
}

/**
 * The last line of defence for errors no caller caught. A rejected promise nobody awaited (a
 * dependency failing in work started without waiting for it) leaves the app's state as it was, so
 * it is logged and the service keeps answering, instead of Node's default of ending the process. A
 * thrown exception may have left anything half-done, so it is logged as fatal and the process ends
 * with 1, for systemd to start it afresh (Restart=on-failure).
 */
export function handleProcessErrors(target: ProcessErrorEvents, { logger, exit }: ProcessErrorHandling): void {
  target.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "Unhandled promise rejection");
  });
  target.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, `Uncaught exception, stopping: ${error.message}`);
    exit(1);
  });
}
