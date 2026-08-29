import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
};

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  mobileE164: text("mobile_e164").notNull(),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "blocked", "deleted"] }).notNull().default("active"),
  lastSignedInAt: text("last_signed_in_at"),
  ...timestamps,
}, table => [uniqueIndex("users_mobile_unique").on(table.mobileE164)]);

export const userRoles = sqliteTable("user_roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => users.id),
  role: text("role", { enum: ["resident", "helper"] }).notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [uniqueIndex("user_roles_user_unique").on(table.userId)]);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [index("sessions_user_idx").on(table.userId), uniqueIndex("sessions_token_unique").on(table.tokenHash)]);

export const residentProfiles = sqliteTable("resident_profiles", {
  userId: text("user_id").primaryKey().references(() => users.id),
  onboardingCompletedAt: text("onboarding_completed_at"),
  ...timestamps,
});

export const residentAddresses = sqliteTable("resident_addresses", {
  id: text("id").primaryKey(),
  residentUserId: text("resident_user_id").notNull().references(() => users.id),
  houseOrFlat: text("house_or_flat").notNull(),
  streetOrBlock: text("street_or_block"),
  locality: text("locality").notNull(),
  landmark: text("landmark"),
  latitude: integer("latitude_e6"),
  longitude: integer("longitude_e6"),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
}, table => [index("resident_addresses_user_idx").on(table.residentUserId)]);

export const helperProfiles = sqliteTable("helper_profiles", {
  userId: text("user_id").primaryKey().references(() => users.id),
  homeLocality: text("home_locality").notNull(),
  homeAddress: text("home_address"),
  landmark: text("landmark"),
  houseOrFlat: text("house_or_flat"),
  floor: text("floor"),
  buildingOrSociety: text("building_or_society"),
  city: text("city"),
  state: text("state"),
  pinCode: text("pin_code"),
  latitude: integer("latitude_e6"),
  longitude: integer("longitude_e6"),
  maxTravelDistanceMeters: integer("max_travel_distance_meters"),
  upiId: text("upi_id"),
  yearsExperience: integer("years_experience").notNull().default(0),
  verificationStatus: text("verification_status", { enum: ["not_submitted", "pending", "verified", "rejected"] }).notNull().default("not_submitted"),
  profileStatus: text("profile_status", { enum: ["draft", "review", "active", "paused", "blocked"] }).notNull().default("draft"),
  ...timestamps,
});

export const verificationDocuments = sqliteTable("verification_documents", {
  id: text("id").primaryKey(),
  helperUserId: text("helper_user_id").notNull().references(() => users.id),
  documentType: text("document_type", { enum: ["aadhaar", "voter_id", "other_address_proof"] }).notNull(),
  r2ObjectKey: text("r2_object_key").notNull(),
  originalFilename: text("original_filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  status: text("status", { enum: ["pending", "verified", "rejected", "deleted"] }).notNull().default("pending"),
  reviewedAt: text("reviewed_at"),
  reviewNote: text("review_note"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [index("verification_documents_helper_idx").on(table.helperUserId)]);

export const helperOfferings = sqliteTable("helper_offerings", {
  id: text("id").primaryKey(),
  helperUserId: text("helper_user_id").notNull().references(() => users.id),
  serviceType: text("service_type", { enum: ["house_cleaning", "utensils_once", "utensils_twice"] }).notNull(),
  homeSize: text("home_size", { enum: ["one_two_bhk", "three_bhk", "four_plus_bhk", "not_applicable"] }).notNull(),
  monthlyPricePaise: integer("monthly_price_paise").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
}, table => [index("helper_offerings_helper_idx").on(table.helperUserId), uniqueIndex("helper_offerings_package_unique").on(table.helperUserId, table.serviceType, table.homeSize)]);

export const availabilitySlots = sqliteTable("availability_slots", {
  id: text("id").primaryKey(),
  helperUserId: text("helper_user_id").notNull().references(() => users.id),
  sourceGroupId: text("source_group_id"),
  dayPattern: text("day_pattern", { enum: ["mon_sat", "mon_fri", "every_day"] }),
  dayOfWeek: integer("day_of_week").notNull(),
  startMinute: integer("start_minute").notNull(),
  endMinute: integer("end_minute").notNull(),
  bufferMinutes: integer("buffer_minutes").notNull().default(15),
  status: text("status", { enum: ["open", "held", "booked", "inactive"] }).notNull().default("open"),
  ...timestamps,
}, table => [index("availability_slots_helper_day_idx").on(table.helperUserId, table.dayOfWeek), index("availability_slots_group_idx").on(table.helperUserId, table.sourceGroupId)]);

export const externalBusyPeriods = sqliteTable("external_busy_periods", {
  id: text("id").primaryKey(),
  helperUserId: text("helper_user_id").notNull().references(() => users.id),
  dayOfWeek: integer("day_of_week").notNull(),
  startMinute: integer("start_minute").notNull(),
  endMinute: integer("end_minute").notNull(),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  ...timestamps,
}, table => [index("external_busy_periods_helper_day_idx").on(table.helperUserId, table.dayOfWeek, table.status)]);

export const bookingRequests = sqliteTable("booking_requests", {
  id: text("id").primaryKey(),
  residentUserId: text("resident_user_id").notNull().references(() => users.id),
  helperUserId: text("helper_user_id").notNull().references(() => users.id),
  residentAddressId: text("resident_address_id").notNull().references(() => residentAddresses.id),
  packageSnapshot: text("package_snapshot_json").notNull(),
  monthlyPricePaise: integer("monthly_price_paise").notNull(),
  requestedStartDate: text("requested_start_date").notNull(),
  status: text("status", { enum: ["pending", "accepted", "declined", "withdrawn", "expired"] }).notNull().default("pending"),
  responseDueAt: text("response_due_at").notNull(),
  respondedAt: text("responded_at"),
  ...timestamps,
}, table => [
  index("booking_requests_resident_idx").on(table.residentUserId),
  index("booking_requests_helper_idx").on(table.helperUserId, table.status),
  uniqueIndex("booking_requests_one_pending_per_resident").on(table.residentUserId).where(sql`${table.status} = 'pending'`),
]);

export const requestSlots = sqliteTable("request_slots", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().references(() => bookingRequests.id),
  availabilitySlotId: text("availability_slot_id").notNull().references(() => availabilitySlots.id),
  visitOrdinal: integer("visit_ordinal").notNull(),
  dayOfWeek: integer("day_of_week").notNull().default(1),
  startMinute: integer("start_minute").notNull().default(0),
  endMinute: integer("end_minute").notNull().default(0),
  includesHouseCleaning: integer("includes_house_cleaning", { mode: "boolean" }).notNull().default(false),
}, table => [index("request_slots_request_idx").on(table.requestId), index("request_slots_time_idx").on(table.dayOfWeek, table.startMinute, table.endMinute), uniqueIndex("request_slots_held_slot_unique").on(table.availabilitySlotId, table.requestId, table.visitOrdinal)]);

export const slotClaims = sqliteTable("slot_claims", {
  id: text("id").primaryKey(),
  helperUserId: text("helper_user_id").notNull().references(() => users.id),
  dayOfWeek: integer("day_of_week").notNull(),
  minuteOfDay: integer("minute_of_day").notNull(),
  requestId: text("request_id").notNull().references(() => bookingRequests.id),
  bookingId: text("booking_id").references(() => bookings.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [
  uniqueIndex("slot_claims_helper_day_minute_unique").on(table.helperUserId, table.dayOfWeek, table.minuteOfDay),
  index("slot_claims_request_idx").on(table.requestId),
  index("slot_claims_booking_idx").on(table.bookingId),
]);

export const bookings = sqliteTable("bookings", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().references(() => bookingRequests.id),
  residentUserId: text("resident_user_id").notNull().references(() => users.id),
  helperUserId: text("helper_user_id").notNull().references(() => users.id),
  status: text("status", { enum: ["trial", "active", "ending", "cancelled", "completed"] }).notNull().default("trial"),
  trialVisitsAllowed: integer("trial_visits_allowed").notNull().default(2),
  trialVisitsCompleted: integer("trial_visits_completed").notNull().default(0),
  cycleStartedAt: text("cycle_started_at").notNull(),
  cycleEndsAt: text("cycle_ends_at").notNull(),
  renewalEnabled: integer("renewal_enabled", { mode: "boolean" }).notNull().default(false),
  endedAt: text("ended_at"),
  ...timestamps,
}, table => [uniqueIndex("bookings_request_unique").on(table.requestId), index("bookings_resident_status_idx").on(table.residentUserId, table.status), index("bookings_helper_status_idx").on(table.helperUserId, table.status)]);

export const bookingSlots = sqliteTable("booking_slots", {
  id: text("id").primaryKey(),
  bookingId: text("booking_id").notNull().references(() => bookings.id),
  availabilitySlotId: text("availability_slot_id").notNull().references(() => availabilitySlots.id),
  visitOrdinal: integer("visit_ordinal").notNull(),
  dayOfWeek: integer("day_of_week").notNull().default(1),
  startMinute: integer("start_minute").notNull().default(0),
  endMinute: integer("end_minute").notNull().default(0),
}, table => [index("booking_slots_booking_idx").on(table.bookingId), index("booking_slots_time_idx").on(table.dayOfWeek, table.startMinute, table.endMinute), uniqueIndex("booking_slots_slot_unique").on(table.availabilitySlotId, table.bookingId, table.visitOrdinal)]);

export const bookingStatusHistory = sqliteTable("booking_status_history", {
  id: text("id").primaryKey(),
  bookingId: text("booking_id").notNull().references(() => bookings.id),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  actorUserId: text("actor_user_id").references(() => users.id),
  reason: text("reason"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [
  index("booking_status_history_booking_idx").on(table.bookingId),
  uniqueIndex("booking_status_history_transition_unique").on(table.bookingId, table.toStatus),
]);

export const workflowTransitions = sqliteTable("workflow_transitions", {
  id: text("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  fromState: text("from_state").notNull(),
  toState: text("to_state").notNull(),
  actorUserId: text("actor_user_id").references(() => users.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [uniqueIndex("workflow_transitions_once_unique").on(table.entityType, table.entityId, table.fromState)]);

export const serviceVisits = sqliteTable("service_visits", {
  id: text("id").primaryKey(),
  bookingId: text("booking_id").notNull().references(() => bookings.id),
  bookingSlotId: text("booking_slot_id").notNull().references(() => bookingSlots.id),
  scheduledFor: text("scheduled_for").notNull(),
  trialOrdinal: integer("trial_ordinal"),
  status: text("status", { enum: ["scheduled", "completed", "helper_no_show", "resident_unavailable", "cancelled"] }).notNull().default("scheduled"),
  completedAt: text("completed_at"),
  residentConfirmedAt: text("resident_confirmed_at"),
  helperConfirmedAt: text("helper_confirmed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [
  index("service_visits_booking_date_idx").on(table.bookingId, table.scheduledFor),
  index("service_visits_status_date_idx").on(table.status, table.scheduledFor),
  uniqueIndex("service_visits_slot_trial_unique").on(table.bookingSlotId, table.trialOrdinal),
]);

export const bookingCancellations = sqliteTable("booking_cancellations", {
  id: text("id").primaryKey(),
  bookingId: text("booking_id").notNull().references(() => bookings.id),
  actorUserId: text("actor_user_id").notNull().references(() => users.id),
  phase: text("phase", { enum: ["trial", "post_cycle"] }).notNull(),
  reason: text("reason").notNull(),
  feedback: text("feedback"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [uniqueIndex("booking_cancellations_booking_unique").on(table.bookingId)]);

export const trialPayments = sqliteTable("trial_payments", {
  id: text("id").primaryKey(),
  bookingId: text("booking_id").notNull().references(() => bookings.id),
  residentUserId: text("resident_user_id").notNull().references(() => users.id),
  helperUserId: text("helper_user_id").notNull().references(() => users.id),
  amountPaise: integer("amount_paise").notNull(),
  status: text("status", { enum: ["pending", "resident_marked_paid", "confirmed", "review_requested", "waived"] }).notNull().default("pending"),
  transactionReference: text("transaction_reference"),
  residentMarkedPaidAt: text("resident_marked_paid_at"),
  helperConfirmedAt: text("helper_confirmed_at"),
  reviewRequestedAt: text("review_requested_at"),
  resolvedAt: text("resolved_at"),
  ...timestamps,
}, table => [uniqueIndex("trial_payments_booking_unique").on(table.bookingId), index("trial_payments_resident_status_idx").on(table.residentUserId, table.status), index("trial_payments_helper_status_idx").on(table.helperUserId, table.status)]);

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
  lastUsedAt: text("last_used_at"),
  ...timestamps,
}, table => [uniqueIndex("push_subscriptions_endpoint_unique").on(table.endpoint), index("push_subscriptions_user_status_idx").on(table.userId, table.status)]);

export const issues = sqliteTable("issues", {
  id: text("id").primaryKey(),
  caseNumber: integer("case_number").notNull(),
  bookingId: text("booking_id").references(() => bookings.id),
  reporterUserId: text("reporter_user_id").notNull().references(() => users.id),
  reportedUserId: text("reported_user_id").references(() => users.id),
  category: text("category").notNull(),
  description: text("description"),
  status: text("status", { enum: ["new", "reviewing", "resolved", "closed"] }).notNull().default("new"),
  internalResolutionNote: text("internal_resolution_note"),
  resolvedAt: text("resolved_at"),
  ...timestamps,
}, table => [uniqueIndex("issues_case_number_unique").on(table.caseNumber), index("issues_status_created_idx").on(table.status, table.createdAt)]);

export const issueCaseCounter = sqliteTable("issue_case_counter", {
  id: integer("id").primaryKey(),
  nextCaseNumber: integer("next_case_number").notNull(),
});

export const issueStatusHistory = sqliteTable("issue_status_history", {
  id: text("id").primaryKey(),
  issueId: text("issue_id").notNull().references(() => issues.id),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  note: text("note"),
  changedBy: text("changed_by").notNull().default("manual_backend_review"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [index("issue_status_history_issue_idx").on(table.issueId)]);

export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey(),
  bookingId: text("booking_id").notNull().references(() => bookings.id),
  authorUserId: text("author_user_id").notNull().references(() => users.id),
  subjectUserId: text("subject_user_id").notNull().references(() => users.id),
  rating: integer("rating").notNull(),
  comment: text("comment"),
  status: text("status", { enum: ["published", "hidden", "disputed"] }).notNull().default("published"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [uniqueIndex("reviews_booking_author_unique").on(table.bookingId, table.authorUserId), index("reviews_subject_idx").on(table.subjectUserId)]);

export const consents = sqliteTable("consents", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  documentType: text("document_type").notNull(),
  documentVersion: text("document_version").notNull(),
  acceptedAt: text("accepted_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revokedAt: text("revoked_at"),
}, table => [index("consents_user_idx").on(table.userId)]);

export const analyticsEvents = sqliteTable("analytics_events", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id),
  anonymousId: text("anonymous_id"),
  sessionId: text("session_id"),
  eventName: text("event_name").notNull(),
  propertiesJson: text("properties_json").notNull().default("{}"),
  occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [index("analytics_events_name_time_idx").on(table.eventName, table.occurredAt), index("analytics_events_user_time_idx").on(table.userId, table.occurredAt)]);

export const notificationLog = sqliteTable("notification_log", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  channel: text("channel", { enum: ["in_app", "sms", "whatsapp"] }).notNull(),
  templateKey: text("template_key").notNull(),
  title: text("title"),
  body: text("body"),
  actionView: text("action_view"),
  relatedEntityType: text("related_entity_type"),
  relatedEntityId: text("related_entity_id"),
  dedupeKey: text("dedupe_key"),
  providerMessageId: text("provider_message_id"),
  status: text("status", { enum: ["queued", "sent", "delivered", "failed"] }).notNull().default("queued"),
  errorCode: text("error_code"),
  readAt: text("read_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [
  index("notification_log_user_idx").on(table.userId),
  index("notification_log_status_idx").on(table.status),
  uniqueIndex("notification_log_dedupe_unique").on(table.dedupeKey),
]);
