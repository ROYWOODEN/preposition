ALTER TABLE `moderator_invitations` ADD `issuer_id` integer;--> statement-breakpoint
ALTER TABLE `moderators` ADD `role` text DEFAULT 'moderator' NOT NULL;