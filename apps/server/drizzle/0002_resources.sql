CREATE TABLE `homes` (
	`username` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`path` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `resources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`local_path` text,
	`root_realpath` text NOT NULL,
	`is_home_root` integer DEFAULT false NOT NULL,
	`home_root_subpath` text,
	`state` text NOT NULL,
	`unavailable_reason` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resources_name_unique` ON `resources` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `resources_one_home_root_idx` ON `resources` (`is_home_root`) WHERE is_home_root = 1;