CREATE TABLE `update_checks` (
	`id` integer PRIMARY KEY NOT NULL,
	`release` text,
	`checked_at` text,
	`failed_at` text
);
--> statement-breakpoint
CREATE TABLE `update_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`username` text NOT NULL,
	`from_version` text NOT NULL,
	`to_version` text NOT NULL,
	`started_at` text NOT NULL,
	`handed_over_at` text,
	`result` text,
	`reason` text,
	`finished_at` text,
	`recorded_at` text
);
