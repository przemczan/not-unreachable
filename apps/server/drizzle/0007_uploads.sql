CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`target_resource_id` text,
	`target_path` text NOT NULL,
	`file_name` text NOT NULL,
	`size` integer NOT NULL,
	`offset` integer DEFAULT 0 NOT NULL,
	`staged_path` text NOT NULL,
	`on_conflict` text NOT NULL,
	`created_at` text NOT NULL,
	`last_chunk_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`temp_name` text,
	`completed_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `uploads_account_idx` ON `uploads` (`account_id`);--> statement-breakpoint
CREATE INDEX `uploads_expires_idx` ON `uploads` (`expires_at`);