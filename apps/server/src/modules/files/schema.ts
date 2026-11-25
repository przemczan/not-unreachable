import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "../accounts/index.ts";

// Literals, not the contracts' array: drizzle-kit loads this file without the contracts package.
// repository.ts checks they equal the contracts'.
export const storedConflictChoices = ["fail", "replace", "keep-both"] as const;

/**
 * Unfinished tus uploads (threat model, T7). A row is made at creation, once every check passed, and
 * deleted when the file is in place, cancelled, or expired; its staged bytes live in
 * `DATA_DIR/uploads/<id>`.
 */
export const uploads = sqliteTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    /** Only this account may continue or cancel the upload. */
    accountId: text("account_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The admin's target resource; null for a user's upload into their own home. */
    targetResourceId: text("target_resource_id"),
    /** The folder, relative to the resource or the home; "" for its top folder. */
    targetPath: text("target_path").notNull(),
    fileName: text("file_name").notNull(),
    /** The declared `Upload-Length`. */
    size: integer("size").notNull(),
    /** The bytes staged so far, as of the last chunk. */
    offset: integer("offset").notNull().default(0),
    stagedPath: text("staged_path").notNull(),
    onConflict: text("on_conflict", { enum: storedConflictChoices }).notNull(),
    createdAt: text("created_at").notNull(),
    lastChunkAt: text("last_chunk_at").notNull(),
    /** 24 hours after the last chunk. */
    expiresAt: text("expires_at").notNull(),
    /** Set while the file is being moved into place: the `.nu-upload-<id>` name in the target folder. */
    tempName: text("temp_name"),
    completedAt: text("completed_at"),
  },
  (table) => [index("uploads_account_idx").on(table.accountId), index("uploads_expires_idx").on(table.expiresAt)],
);

export type UploadRow = typeof uploads.$inferSelect;
export type NewUploadRow = typeof uploads.$inferInsert;
