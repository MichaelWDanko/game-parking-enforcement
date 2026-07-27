CREATE TABLE `scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`player_name` text NOT NULL,
	`score` integer NOT NULL,
	`tickets` integer NOT NULL,
	`boots` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scores_run_id_unique` ON `scores` (`run_id`);--> statement-breakpoint
CREATE INDEX `scores_rank_idx` ON `scores` (`score`,`created_at`);