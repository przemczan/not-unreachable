CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_user_id` text,
	`token_hash` text NOT NULL,
	`token` text NOT NULL,
	`email` text,
	`created_by` text,
	`expires_at` text NOT NULL,
	`accepted_user_id` text,
	`accepted_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`accepted_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_hash_unique` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invitations_kind_created_idx` ON `invitations` (`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `invitations_target_idx` ON `invitations` (`target_user_id`);--> statement-breakpoint
CREATE TABLE `reserved_usernames` (
	`username` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mail_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`tls_mode` text NOT NULL,
	`username` text,
	`password` text,
	`from_address` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`email` text,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`quota_bytes` integer,
	`created_at` text NOT NULL,
	`disabled_at` text
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "username", "email", "display_name", "role", "status", "quota_bytes", "created_at", "disabled_at") SELECT "id", "username", "email", "display_name", "role", "status", "quota_bytes", "created_at", "disabled_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_one_admin_idx` ON `users` (`role`) WHERE role = 'admin';--> statement-breakpoint
ALTER TABLE `sso_flows` ADD `purpose_data` text;