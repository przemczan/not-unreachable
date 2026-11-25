/** Runs async work one piece at a time per key, in the order it was handed in; other keys run alongside. */
export interface KeyedSerial {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
}

/**
 * An in-process lock per key. A try limit checks its counters, awaits a slow proof (argon2, a
 * signature), then counts the failure: without this, parallel tries would all pass the check before
 * any failure is counted (threat model, T11). The app runs as one process, so this is enough.
 */
export function createKeyedSerial(): KeyedSerial {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run(key, work) {
      const result = (tails.get(key) ?? Promise.resolve()).then(work);
      // The next piece waits for this one however it ends; the last one out forgets the key.
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
  };
}
