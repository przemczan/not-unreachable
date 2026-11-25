CREATE TABLE `share_link_users` (
	`share_link_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`share_link_id`, `user_id`),
	FOREIGN KEY (`share_link_id`) REFERENCES `share_links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_link_users_user_idx` ON `share_link_users` (`user_id`);--> statement-breakpoint
ALTER TABLE `share_links` ADD `access` text DEFAULT 'anyone' NOT NULL;