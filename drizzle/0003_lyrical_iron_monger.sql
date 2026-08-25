ALTER TABLE `availability_slots` ADD `source_group_id` text;--> statement-breakpoint
ALTER TABLE `availability_slots` ADD `day_pattern` text;--> statement-breakpoint
CREATE INDEX `availability_slots_group_idx` ON `availability_slots` (`helper_user_id`,`source_group_id`);