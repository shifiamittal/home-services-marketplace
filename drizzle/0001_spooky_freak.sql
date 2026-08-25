CREATE TABLE `service_visits` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`booking_slot_id` text NOT NULL,
	`scheduled_for` text NOT NULL,
	`trial_ordinal` integer,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`completed_at` text,
	`resident_confirmed_at` text,
	`helper_confirmed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`booking_slot_id`) REFERENCES `booking_slots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `service_visits_booking_date_idx` ON `service_visits` (`booking_id`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `service_visits_status_date_idx` ON `service_visits` (`status`,`scheduled_for`);