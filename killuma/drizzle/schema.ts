import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, decimal, json } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const videos = mysqlTable("videos", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  title: text("title"),
  prompt: text("prompt").notNull(),
  referenceImageUrl: text("referenceImageUrl"),
  referenceImageKey: text("referenceImageKey"),
  status: mysqlEnum("status", ["deploying", "processing", "complete", "failed"]).default("deploying").notNull(),
  videoUrl: text("videoUrl"),
  videoKey: text("videoKey"),
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Video = typeof videos.$inferSelect;
export type InsertVideo = typeof videos.$inferInsert;

export const jobs = mysqlTable("jobs", {
  id: int("id").autoincrement().primaryKey(),
  videoId: int("videoId").notNull(),
  status: mysqlEnum("status", ["deploying", "processing", "complete", "failed"]).default("deploying").notNull(),
  progress: int("progress").default(0).notNull(),
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
});

export type Job = typeof jobs.$inferSelect;
export type InsertJob = typeof jobs.$inferInsert;

export const swarmStats = mysqlTable("swarmStats", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  gpuHoursContributed: decimal("gpuHoursContributed", { precision: 10, scale: 2 }).default("0").notNull(),
  killTokensEarned: decimal("killTokensEarned", { precision: 15, scale: 2 }).default("0").notNull(),
  lastUpdated: timestamp("lastUpdated").defaultNow().onUpdateNow().notNull(),
});

export type SwarmStats = typeof swarmStats.$inferSelect;
export type InsertSwarmStats = typeof swarmStats.$inferInsert;

export const studioProjects = mysqlTable("studioProjects", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  title: text("title").notNull(),
  timelineData: json("timelineData"),
  motionBrushData: json("motionBrushData"),
  cameraPathData: json("cameraPathData"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type StudioProject = typeof studioProjects.$inferSelect;
export type InsertStudioProject = typeof studioProjects.$inferInsert;

export const captureReconstructions = mysqlTable("captureReconstructions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  inputVideoUrl: text("inputVideoUrl").notNull(),
  inputVideoKey: text("inputVideoKey").notNull(),
  reconstructionData: json("reconstructionData"),
  status: mysqlEnum("status", ["processing", "complete", "failed"]).default("processing").notNull(),
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
});

export type CaptureReconstruction = typeof captureReconstructions.$inferSelect;
export type InsertCaptureReconstruction = typeof captureReconstructions.$inferInsert;
export const swarmNodes = mysqlTable("swarmNodes", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  nodeId: varchar("nodeId", { length: 255 }).notNull().unique(),
  gpuModel: text("gpuModel"),
  gpuMemoryGb: int("gpuMemoryGb"),
  status: mysqlEnum("status", ["online", "offline", "training"]).default("online").notNull(),
  lastHeartbeat: timestamp("lastHeartbeat").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type SwarmNode = typeof swarmNodes.$inferSelect;
export type InsertSwarmNode = typeof swarmNodes.$inferInsert;

export const trainingJobs = mysqlTable("trainingJobs", {
  id: int("id").autoincrement().primaryKey(),
  jobId: varchar("jobId", { length: 255 }).notNull().unique(),
  modelType: mysqlEnum("modelType", ["base", "lora"]).default("lora").notNull(),
  status: mysqlEnum("status", ["queued", "training", "complete", "failed"]).default("queued").notNull(),
  datasetSize: int("datasetSize"),
  progress: int("progress").default(0).notNull(),
  nodeIds: json("nodeIds"),
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
});

export type TrainingJob = typeof trainingJobs.$inferSelect;
export type InsertTrainingJob = typeof trainingJobs.$inferInsert;

export const cameraControls = mysqlTable("cameraControls", {
  id: int("id").autoincrement().primaryKey(),
  videoId: int("videoId").notNull(),
  controlType: mysqlEnum("controlType", ["pan", "zoom", "rotation", "dolly", "orbit"]).notNull(),
  startFrame: int("startFrame").notNull(),
  endFrame: int("endFrame").notNull(),
  intensity: decimal("intensity", { precision: 5, scale: 2 }).default("1.0").notNull(),
  easing: mysqlEnum("easing", ["linear", "easeIn", "easeOut", "easeInOut"]).default("linear").notNull(),
  conditioningData: json("conditioningData"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type CameraControl = typeof cameraControls.$inferSelect;
export type InsertCameraControl = typeof cameraControls.$inferInsert;
