/** Runs async work one piece at a time, in the order it was handed in. */
export interface Serial {
  run<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * An in-process lock. Accepting an invitation makes the home folder (async) before its one SQLite
 * transaction, which can't hold an await, so the checks, the folder and the transaction of two
 * callbacks must not interleave. The app runs as one process, so this is enough.
 */
export function createSerial(): Serial {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(work) {
      const result = tail.then(work);
      // The next piece waits for this one however it ends.
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
