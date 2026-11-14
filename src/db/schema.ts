import {
  sqliteTable,
  integer,
  text,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
export const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  username: text("username"),
  blocked: integer("blocked", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  activeAt: integer("active_at").notNull(),
});
export const moderators = sqliteTable("moderators", {
  id: integer("id")
    .primaryKey()
    .references(() => users.id),
});
export const submissions = sqliteTable(
  "submissions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    authorId: integer("author_id")
      .notNull()
      .references(() => users.id),
    status: text("status", {
      enum: ["draft", "pending", "approved", "rejected", "cancelled"],
    })
      .notNull()
      .default("draft"),
    delivery: text("delivery", {
      enum: ["none", "publishing", "published", "failed", "needs_review"],
    })
      .notNull()
      .default("none"),
    body: text("body").notNull().default(""),
    entities: text("entities").notNull().default("[]"),
    anonymous: integer("anonymous", { mode: "boolean" })
      .notNull()
      .default(false),
    version: integer("version").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    submittedAt: integer("submitted_at"),
    moderatorId: integer("moderator_id").references(() => users.id),
    reason: text("reason"),
    publishedAt: integer("published_at"),
  },
  (t) => [index("submission_author_status").on(t.authorId, t.status)],
);
export const media = sqliteTable(
  "submission_media",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    submissionId: integer("submission_id")
      .notNull()
      .references(() => submissions.id),
    kind: text("kind", {
      enum: ["photo", "video", "document", "animation", "audio", "voice"],
    }).notNull(),
    fileId: text("file_id").notNull(),
    uniqueId: text("unique_id").notNull(),
    messageId: integer("message_id").notNull(),
    groupId: text("group_id"),
  },
  (t) => [uniqueIndex("media_source").on(t.submissionId, t.messageId)],
);
export const states = sqliteTable("user_states", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id),
  value: text("value").notNull(),
});
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
export const templates = sqliteTable("message_templates", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
export const updates = sqliteTable("processed_updates", {
  id: integer("id").primaryKey(),
});
export const history = sqliteTable("moderation_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actorId: integer("actor_id").notNull(),
  submissionId: integer("submission_id").references(() => submissions.id),
  action: text("action").notNull(),
  at: integer("at").notNull(),
});
export const attempts = sqliteTable("publication_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  submissionId: integer("submission_id")
    .notNull()
    .references(() => submissions.id),
  startedAt: integer("started_at").notNull(),
  result: text("result").notNull(),
  messageIds: text("message_ids"),
});
export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull().default("pending"),
  tries: integer("tries").notNull().default(0),
  nextAt: integer("next_at").notNull(),
  buttonText: text("button_text"),
  buttonCallback: text("button_callback"),
});
export const invitations = sqliteTable("moderator_invitations", {
  hash: text("hash").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
  candidateId: integer("candidate_id").references(() => users.id),
  status: text("status").notNull().default("open"),
});
