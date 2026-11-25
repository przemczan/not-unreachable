import { hash, parseOptions, verify } from "@node-rs/argon2";
import { newToken } from "../platform/index.ts";
import { PasswordHashingBusyError, type ConcurrencyLimiter } from "./limiter.ts";

/** argon2id parameters; the algorithm is @node-rs/argon2's default (argon2id, version 0x13) and the salt its own 16 random bytes. */
export interface PasswordHashingParameters {
  /** KiB. */
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
  /** Bytes. */
  readonly outputLen: number;
}

/** stack.md, "Password hashing": m = 64 MiB, t = 3, p = 1, 32-byte output. */
export const passwordHashingParameters: PasswordHashingParameters = { memoryCost: 65_536, timeCost: 3, parallelism: 1, outputLen: 32 };

/** @node-rs/argon2's `Algorithm.Argon2id`: a const enum, which type stripping can't import as a value. */
const ARGON2ID: number = 2;
const SALT_BYTES = 16;

export interface PasswordHasher {
  /** A PHC string with the current parameters. */
  hash(password: string): Promise<string>;
  /** False for a wrong password and for a hash that can't be read. */
  verify(phc: string, password: string): Promise<boolean>;
  /** Verifies against a dummy hash with the current parameters, so a missing account or password takes the same time. */
  verifyDummy(password: string): Promise<void>;
  /** Whether a stored hash was made with other parameters than the current ones. */
  needsRehash(phc: string): boolean;
}

export function createPasswordHasher(parameters: PasswordHashingParameters, limiter: ConcurrencyLimiter): PasswordHasher {
  const options = { ...parameters };
  let dummy: Promise<string> | undefined;

  const verifyLimited = (phc: string, password: string): Promise<boolean> =>
    limiter
      .run(() => verify(phc, password))
      .catch((error: unknown) => {
        if (error instanceof PasswordHashingBusyError) throw error;
        return false;
      });

  return {
    hash: (password) => limiter.run(() => hash(password, options)),
    verify: verifyLimited,
    async verifyDummy(password) {
      // Made once, lazily; a failed attempt (the limiter was busy) is tried again next time.
      dummy ??= limiter
        .run(() => hash(newToken(), options))
        .catch((error: unknown) => {
          dummy = undefined;
          throw error;
        });
      await verifyLimited(await dummy, password);
    },
    needsRehash(phc) {
      try {
        const stored = parseOptions(phc);
        const algorithm: number = stored.algorithm;
        return (
          algorithm !== ARGON2ID ||
          stored.memoryCost !== parameters.memoryCost ||
          stored.timeCost !== parameters.timeCost ||
          stored.parallelism !== parameters.parallelism ||
          stored.outputLen !== parameters.outputLen ||
          stored.saltLen !== SALT_BYTES
        );
      } catch {
        return true;
      }
    },
  };
}
