import { z } from "zod";
import { backupDatabase } from "./backups.ts";
import type { Clock } from "./clock.ts";
import type { Database } from "./database.ts";
import { generateMasterKey, keyFileNames, promoteNewKeyFile, readMasterKeyFile, writeKeyFile } from "./master-key.ts";
import { createSecrets, envelopeColumns, type EnvelopeColumn } from "./secrets.ts";

const envelopeRows = z.array(z.object({ id: z.string(), envelope: z.string() }));

export interface RotateMasterKeyInput {
  readonly database: Database;
  readonly oldKey: Uint8Array;
  readonly newKey: Uint8Array;
  readonly columns: readonly EnvelopeColumn[];
}

export interface ColumnRotation {
  readonly table: string;
  readonly column: string;
  readonly reencrypted: number;
}

/** Re-encrypts every non-null envelope of every column under the new key, in one transaction. */
export function rotateMasterKey(input: RotateMasterKeyInput): ColumnRotation[] {
  const oldSecrets = createSecrets(input.oldKey);
  const newSecrets = createSecrets(input.newKey);
  const { sqlite } = input.database;
  return sqlite
    .transaction(() =>
      input.columns.map(({ table, column, purpose }) => {
        const select = sqlite.prepare(
          `SELECT id, ${quoteIdentifier(column)} AS envelope FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NOT NULL`,
        );
        const update = sqlite.prepare(`UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(column)} = ? WHERE id = ?`);
        const rows = envelopeRows.parse(select.all());
        for (const row of rows) {
          const aad = { table, column, rowId: row.id };
          const plaintext = oldSecrets.decrypt(purpose, aad, row.envelope);
          update.run(newSecrets.encrypt(purpose, aad, plaintext), row.id);
        }
        return { table, column, reencrypted: rows.length };
      }),
    )
    .immediate();
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export interface KeyRotationInput {
  readonly database: Database;
  readonly backupsDir: string;
  readonly clock: Clock;
  /** The current master key file, e.g. `/etc/not-unreachable/credentials/master.key`. */
  readonly keyFile: string;
  readonly columns?: readonly EnvelopeColumn[];
}

export interface KeyRotationResult {
  readonly backupFile: string;
  readonly keyFile: string;
  readonly previousKeyFile: string;
  readonly oldKeyId: string;
  readonly newKeyId: string;
  readonly columns: readonly ColumnRotation[];
}

/**
 * `not-unreachable rotate-key`: backs the database up, writes `master.key.new`, re-encrypts every
 * envelope in one transaction, then renames `master.key` → `master.key.previous` and
 * `master.key.new` → `master.key`.
 */
export function runKeyRotation(input: KeyRotationInput): KeyRotationResult {
  const names = keyFileNames(input.keyFile);
  const oldKey = readMasterKeyFile(names.current);
  const backup = backupDatabase(input.database, input.backupsDir, input.clock);
  const newKey = generateMasterKey();
  try {
    writeKeyFile(names.next, newKey);
    const columns = rotateMasterKey({
      database: input.database,
      oldKey,
      newKey,
      columns: input.columns ?? envelopeColumns,
    });
    promoteNewKeyFile(names);
    return {
      backupFile: backup.file,
      keyFile: names.current,
      previousKeyFile: names.previous,
      oldKeyId: createSecrets(oldKey).keyId,
      newKeyId: createSecrets(newKey).keyId,
      columns,
    };
  } finally {
    oldKey.fill(0);
    newKey.fill(0);
  }
}
