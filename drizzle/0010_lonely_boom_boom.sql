CREATE TABLE `issue_case_counter` (
	`id` integer PRIMARY KEY NOT NULL,
	`next_case_number` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `issue_case_counter` (`id`, `next_case_number`)
SELECT 1, COALESCE(MAX(`case_number`), 1000) + 1 FROM `issues`;--> statement-breakpoint
CREATE TABLE `slot_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`helper_user_id` text NOT NULL,
	`day_of_week` integer NOT NULL,
	`minute_of_day` integer NOT NULL,
	`request_id` text NOT NULL,
	`booking_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`helper_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`request_id`) REFERENCES `booking_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slot_claims_helper_day_minute_unique` ON `slot_claims` (`helper_user_id`,`day_of_week`,`minute_of_day`);--> statement-breakpoint
CREATE INDEX `slot_claims_request_idx` ON `slot_claims` (`request_id`);--> statement-breakpoint
CREATE INDEX `slot_claims_booking_idx` ON `slot_claims` (`booking_id`);--> statement-breakpoint
UPDATE `booking_requests` SET `status` = 'expired', `updated_at` = CURRENT_TIMESTAMP
WHERE `id` IN (
	SELECT `id` FROM (
		SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `resident_user_id` ORDER BY `created_at`, `id`) AS `row_number`
		FROM `booking_requests` WHERE `status` = 'pending'
	) WHERE `row_number` > 1
);--> statement-breakpoint
WITH RECURSIVE `claim_source` (`helper_user_id`, `day_of_week`, `absolute_minute`, `end_with_buffer`, `request_id`, `booking_id`) AS (
	SELECT br.`helper_user_id`, rs.`day_of_week`, rs.`start_minute`, rs.`end_minute` + 15, br.`id`, NULL
	FROM `request_slots` rs
	JOIN `booking_requests` br ON br.`id` = rs.`request_id`
	WHERE br.`status` = 'pending' AND br.`response_due_at` > CURRENT_TIMESTAMP
	UNION ALL
	SELECT b.`helper_user_id`, bs.`day_of_week`, bs.`start_minute`, bs.`end_minute` + 15, b.`request_id`, b.`id`
	FROM `booking_slots` bs
	JOIN `bookings` b ON b.`id` = bs.`booking_id`
	WHERE b.`status` IN ('trial', 'active', 'ending')
), `expanded` (`helper_user_id`, `day_of_week`, `absolute_minute`, `end_with_buffer`, `request_id`, `booking_id`) AS (
	SELECT `helper_user_id`, `day_of_week`, `absolute_minute`, `end_with_buffer`, `request_id`, `booking_id` FROM `claim_source`
	UNION ALL
	SELECT `helper_user_id`, `day_of_week`, `absolute_minute` + 1, `end_with_buffer`, `request_id`, `booking_id`
	FROM `expanded`
	WHERE `absolute_minute` + 1 < `end_with_buffer`
)
INSERT INTO `slot_claims` (`id`, `helper_user_id`, `day_of_week`, `minute_of_day`, `request_id`, `booking_id`)
SELECT `request_id` || ':' || ((`day_of_week` + CAST(`absolute_minute` / 1440 AS integer)) % 7) || ':' || (`absolute_minute` % 1440),
	`helper_user_id`, (`day_of_week` + CAST(`absolute_minute` / 1440 AS integer)) % 7, `absolute_minute` % 1440, `request_id`, `booking_id`
FROM `expanded`;--> statement-breakpoint
CREATE TABLE `workflow_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`from_state` text NOT NULL,
	`to_state` text NOT NULL,
	`actor_user_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_transitions_once_unique` ON `workflow_transitions` (`entity_type`,`entity_id`,`from_state`);--> statement-breakpoint
ALTER TABLE `notification_log` ADD `dedupe_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_log_dedupe_unique` ON `notification_log` (`dedupe_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `booking_requests_one_pending_per_resident` ON `booking_requests` (`resident_user_id`) WHERE "booking_requests"."status" = 'pending';--> statement-breakpoint
DELETE FROM `booking_status_history` WHERE `id` IN (
	SELECT `id` FROM (
		SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `booking_id`, `to_status` ORDER BY `created_at`, `id`) AS `row_number`
		FROM `booking_status_history`
	) WHERE `row_number` > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX `booking_status_history_transition_unique` ON `booking_status_history` (`booking_id`,`to_status`);--> statement-breakpoint
DELETE FROM `service_visits` WHERE `id` IN (
	SELECT `id` FROM (
		SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `booking_slot_id`, `trial_ordinal` ORDER BY `created_at`, `id`) AS `row_number`
		FROM `service_visits` WHERE `trial_ordinal` IS NOT NULL
	) WHERE `row_number` > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX `service_visits_slot_trial_unique` ON `service_visits` (`booking_slot_id`,`trial_ordinal`);
