import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { handleProcessErrors } from "./process-errors.ts";
import { captureLogger } from "./test-support/helpers.ts";

const ERROR = 50;
const FATAL = 60;

function setUp() {
  const target = new EventEmitter();
  const capture = captureLogger();
  const exit = vi.fn<(code: number) => void>();
  handleProcessErrors(target, { logger: capture.logger, exit });
  return { target, exit, lines: capture.lines };
}

describe("handleProcessErrors", () => {
  it("logs a promise rejection nobody handled and keeps the process running", () => {
    const { target, exit, lines } = setUp();
    target.emit("unhandledRejection", new Error("The provider timed out"));
    expect(exit).not.toHaveBeenCalled();
    expect(lines()).toMatchObject([{ level: ERROR, msg: "Unhandled promise rejection", err: { message: "The provider timed out" } }]);
  });

  it("logs an uncaught exception as fatal and ends the process with 1, for systemd to restart it", () => {
    const { target, exit, lines } = setUp();
    target.emit("uncaughtException", new TypeError("Cannot read properties of undefined"));
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines()).toMatchObject([
      { level: FATAL, msg: "Uncaught exception, stopping: Cannot read properties of undefined", err: { type: "TypeError" } },
    ]);
  });
});
