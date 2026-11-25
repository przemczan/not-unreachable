CREATE TABLE `linked_sign_ins` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`email_at_link` text,
	`created_at` text NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `sso_providers`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `linked_sign_ins_identity_idx` ON `linked_sign_ins` (`issuer`,`subject`);--> statement-breakpoint
CREATE INDEX `linked_sign_ins_user_idx` ON `linked_sign_ins` (`user_id`);--> statement-breakpoint
CREATE TABLE `sso_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`purpose` text NOT NULL,
	`binding_hash` text NOT NULL,
	`state` text NOT NULL,
	`nonce` text,
	`code_verifier` text NOT NULL,
	`account_id` text,
	`session_id` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `sso_providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sso_flows_binding_hash_unique` ON `sso_flows` (`binding_hash`);--> statement-breakpoint
CREATE INDEX `sso_flows_expires_idx` ON `sso_flows` (`expires_at`);--> statement-breakpoint
CREATE TABLE `sso_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sso_providers_issuer_unique` ON `sso_providers` (`issuer`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `sign_in_method` text DEFAULT 'password' NOT NULL;