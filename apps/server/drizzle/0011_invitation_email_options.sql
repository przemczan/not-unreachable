ALTER TABLE `invitations` ADD `send_by_email` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `invitations` ADD `verify_email` integer DEFAULT false NOT NULL;