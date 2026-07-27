CREATE TABLE `score_rate_limits` (
	`session_id` text PRIMARY KEY NOT NULL,
	`source_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `score_rate_limits_source_created_idx` ON `score_rate_limits` (`source_hash`,`created_at`);