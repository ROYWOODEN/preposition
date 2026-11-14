CREATE TABLE `moderator_invitations` (
	`hash` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`candidate_id` integer,
	`status` text DEFAULT 'open' NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `notifications` ADD `button_text` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `button_callback` text;