DROP INDEX `user_roles_user_role_unique`;--> statement-breakpoint
DELETE FROM `user_roles`
WHERE `id` NOT IN (
	SELECT MIN(`id`) FROM `user_roles` GROUP BY `user_id`
);--> statement-breakpoint
CREATE UNIQUE INDEX `user_roles_user_unique` ON `user_roles` (`user_id`);
