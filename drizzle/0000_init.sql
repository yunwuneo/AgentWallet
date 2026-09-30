CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`overdraft_limit` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "accounts_overdraft_non_negative" CHECK("accounts"."overdraft_limit" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_user_name_uq` ON `accounts` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`from_account_id` text,
	`from_external` text,
	`to_account_id` text,
	`to_external` text,
	`amount` integer NOT NULL,
	`reason` text NOT NULL,
	`message_id` text,
	`idempotency_key` text,
	`status` text DEFAULT 'active' NOT NULL,
	`void_reason` text,
	`voided_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transactions_amount_positive" CHECK("transactions"."amount" > 0),
	CONSTRAINT "transactions_from_one_side" CHECK(("transactions"."from_account_id" IS NULL) <> ("transactions"."from_external" IS NULL)),
	CONSTRAINT "transactions_to_one_side" CHECK(("transactions"."to_account_id" IS NULL) <> ("transactions"."to_external" IS NULL)),
	CONSTRAINT "transactions_has_account" CHECK("transactions"."from_account_id" IS NOT NULL OR "transactions"."to_account_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_user_idem_uq` ON `transactions` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `transactions_from_idx` ON `transactions` (`from_account_id`,`status`);--> statement-breakpoint
CREATE INDEX `transactions_to_idx` ON `transactions` (`to_account_id`,`status`);--> statement-breakpoint
CREATE INDEX `transactions_user_created_idx` ON `transactions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `transactions_user_message_idx` ON `transactions` (`user_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
