CREATE TABLE `publication_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`submission_id` integer NOT NULL,
	`started_at` integer NOT NULL,
	`result` text NOT NULL,
	`message_ids` text,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `moderation_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer NOT NULL,
	`submission_id` integer,
	`action` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `submission_media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`submission_id` integer NOT NULL,
	`kind` text NOT NULL,
	`file_id` text NOT NULL,
	`unique_id` text NOT NULL,
	`message_id` integer NOT NULL,
	`group_id` text,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_source` ON `submission_media` (`submission_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `moderators` (
	`id` integer PRIMARY KEY NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_states` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`delivery` text DEFAULT 'none' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`entities` text DEFAULT '[]' NOT NULL,
	`anonymous` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`submitted_at` integer,
	`moderator_id` integer,
	`reason` text,
	`published_at` integer,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`moderator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `submission_author_status` ON `submissions` (`author_id`,`status`);--> statement-breakpoint
CREATE TABLE `message_templates` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `processed_updates` (
	`id` integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`username` text,
	`blocked` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`active_at` integer NOT NULL
);
