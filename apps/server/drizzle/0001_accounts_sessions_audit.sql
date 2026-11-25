CREATE TABLE `password_credentials` (
	`user_id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `setup_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `setup_tokens_token_hash_unique` ON `setup_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`quota_bytes` integer,
	`created_at` text NOT NULL,
	`disabled_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_one_admin_idx` ON `users` (`role`) WHERE role = 'admin';--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_account_id` text,
	`actor_username` text,
	`action` text NOT NULL,
	`target_kind` text,
	`target_id` text,
	`outcome` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`details` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_at_idx` ON `audit_events` (`at`);--> statement-breakpoint
CREATE INDEX `audit_events_action_idx` ON `audit_events` (`action`,`at`);--> statement-breakpoint
CREATE INDEX `audit_events_actor_idx` ON `audit_events` (`actor_account_id`,`at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`recent_sign_in_at` text,
	`ip` text,
	`user_agent` text,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `sign_in_failures` (
	`subject_key` text NOT NULL,
	`ip_key` text NOT NULL,
	`failures` integer NOT NULL,
	`last_failure_at` text NOT NULL,
	`delayed_until` text,
	PRIMARY KEY(`subject_key`, `ip_key`)
);
--> statement-breakpoint
CREATE TABLE `sign_in_locks` (
	`subject_key` text PRIMARY KEY NOT NULL,
	`window_started_at` text NOT NULL,
	`failures` integer NOT NULL,
	`locked_until` text
);
