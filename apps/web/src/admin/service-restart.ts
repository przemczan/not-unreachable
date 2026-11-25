import { useEffect, useRef } from "react";
import { api } from "../api/index.ts";

/** How a screen waits for the service to answer again after a restart, in milliseconds; tests shorten it. */
export interface ServiceWaitTiming {
  /** Before the first health check. */
  firstCheckMs: number;
  /** Between health checks. */
  checkEveryMs: number;
  /** A health check that hasn't answered by then is stopped, and counts as failed. */
  checkTimeoutMs: number;
  /**
   * A health check that answers before one has failed may be the old process, still stopping: it
   * counts as the service being back only after this long.
   */
  settleMs: number;
  /** Gives up waiting and says the service didn't come back. */
  giveUpMs: number;
}

/**
 * Checks `/api/v1/health` while `since` (when the restart began) is set, then calls `onBack` once
 * the service answers again, or `onGaveUp` after `giveUpMs`. The timing is read when the wait
 * starts, so tests can shorten it.
 */
export function useServiceComeback(since: number | null, timing: ServiceWaitTiming, onBack: () => void, onGaveUp: () => void): void {
  // The latest callbacks, so new ones from the caller don't restart the wait.
  const back = useRef(onBack);
  const gaveUp = useRef(onGaveUp);
  useEffect(() => {
    back.current = onBack;
    gaveUp.current = onGaveUp;
  }, [onBack, onGaveUp]);

  useEffect(() => {
    if (since === null) return undefined;
    const { firstCheckMs, checkEveryMs, checkTimeoutMs, settleMs, giveUpMs } = timing;
    let failedOnce = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      let up = false;
      try {
        // A check that hangs would hold up the next one and the give-up.
        await api("health", { signal: AbortSignal.timeout(checkTimeoutMs) });
        up = true;
      } catch {
        failedOnce = true;
      }
      if (stopped) return;
      const waited = Date.now() - since;
      if (up && (failedOnce || waited >= settleMs)) back.current();
      else if (waited >= giveUpMs) gaveUp.current();
      else timer = setTimeout(() => void check(), checkEveryMs);
    };
    timer = setTimeout(() => void check(), firstCheckMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [since, timing]);
}
