ALTER TABLE `scores` ADD `challenge_id` text DEFAULT 'classic' NOT NULL;--> statement-breakpoint
ALTER TABLE `scores` ADD `ruleset_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `scores` ADD `objective_id` text;--> statement-breakpoint
ALTER TABLE `scores` ADD `objective_completed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `scores` ADD `objective_bonus` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `scores_challenge_rank_idx` ON `scores` (`challenge_id`,`score`,`created_at`);