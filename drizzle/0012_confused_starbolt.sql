CREATE TABLE `external_busy_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`helper_user_id` text NOT NULL,
	`day_of_week` integer NOT NULL,
	`start_minute` integer NOT NULL,
	`end_minute` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`helper_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `external_busy_periods_helper_day_idx` ON `external_busy_periods` (`helper_user_id`,`day_of_week`,`status`);