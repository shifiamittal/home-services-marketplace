CREATE TABLE `booking_cancellations` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`phase` text NOT NULL,
	`reason` text NOT NULL,
	`feedback` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_cancellations_booking_unique` ON `booking_cancellations` (`booking_id`);--> statement-breakpoint
CREATE TABLE `trial_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`resident_user_id` text NOT NULL,
	`helper_user_id` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`transaction_reference` text,
	`resident_marked_paid_at` text,
	`helper_confirmed_at` text,
	`review_requested_at` text,
	`resolved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resident_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`helper_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trial_payments_booking_unique` ON `trial_payments` (`booking_id`);--> statement-breakpoint
CREATE INDEX `trial_payments_resident_status_idx` ON `trial_payments` (`resident_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `trial_payments_helper_status_idx` ON `trial_payments` (`helper_user_id`,`status`);