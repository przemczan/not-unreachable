CREATE TABLE `share_link_unlocks` (
	`id` text PRIMARY KEY NOT NULL,
	`share_link_id` text NOT NULL,
	`unlock_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`share_link_id`) REFERENCES `share_links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_link_unlocks_unlock_hash_unique` ON `share_link_unlocks` (`unlock_hash`);--> statement-breakpoint
CREATE INDEX `share_link_unlocks_link_idx` ON `share_link_unlocks` (`share_link_id`);--> statement-breakpoint
CREATE INDEX `share_link_unlocks_expires_idx` ON `share_link_unlocks` (`expires_at`);--> statement-breakpoint
CREATE TABLE `share_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`token` text NOT NULL,
	`resource_id` text NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`password_hash` text,
	`expires_at` text,
	`locked_until` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`revoked_at` text,
	`download_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_links_token_hash_unique` ON `share_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `share_links_created_idx` ON `share_links` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `share_links_resource_idx` ON `share_links` (`resource_id`);