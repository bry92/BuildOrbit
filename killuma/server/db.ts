import { eq, and, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, videos, InsertVideo, Video, jobs, InsertJob, Job, swarmStats, InsertSwarmStats, SwarmStats, studioProjects, InsertStudioProject, StudioProject, captureReconstructions, InsertCaptureReconstruction, CaptureReconstruction, swarmNodes, InsertSwarmNode, SwarmNode, trainingJobs, InsertTrainingJob, TrainingJob, cameraControls, InsertCameraControl, CameraControl } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// Video queries
export async function createVideo(video: InsertVideo): Promise<Video> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const result = await db.insert(videos).values(video);
  const videoId = result[0].insertId;
  const created = await db.select().from(videos).where(eq(videos.id, videoId as number)).limit(1);
  return created[0];
}

export async function getVideoById(id: number): Promise<Video | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db.select().from(videos).where(eq(videos.id, id)).limit(1);
  return result[0];
}

export async function getUserVideos(userId: number, limit: number = 20, offset: number = 0): Promise<Video[]> {
  const db = await getDb();
  if (!db) return [];
  
  return db.select().from(videos).where(eq(videos.userId, userId)).orderBy(desc(videos.createdAt)).limit(limit).offset(offset);
}

export async function updateVideoStatus(id: number, status: Video["status"], videoUrl?: string | null, errorMessage?: string | null): Promise<void> {
  const db = await getDb();
  if (!db) return;
  
  const updateData: Record<string, unknown> = { status };
  if (videoUrl !== undefined) updateData.videoUrl = videoUrl;
  if (errorMessage !== undefined) updateData.errorMessage = errorMessage;
  
  await db.update(videos).set(updateData).where(eq(videos.id, id));
}

// Job queries
export async function createJob(job: InsertJob): Promise<Job> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const result = await db.insert(jobs).values(job);
  const jobId = result[0].insertId;
  const created = await db.select().from(jobs).where(eq(jobs.id, jobId as number)).limit(1);
  return created[0];
}

export async function getJobByVideoId(videoId: number): Promise<Job | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db.select().from(jobs).where(eq(jobs.videoId, videoId)).limit(1);
  return result[0];
}

export async function updateJobStatus(id: number, status: Job["status"], progress?: number, errorMessage?: string | null): Promise<void> {
  const db = await getDb();
  if (!db) return;
  
  const updateData: Record<string, unknown> = { status };
  if (progress !== undefined) updateData.progress = progress;
  if (errorMessage !== undefined) updateData.errorMessage = errorMessage;
  if (status === "complete" || status === "failed") {
    updateData.completedAt = new Date();
  }
  
  await db.update(jobs).set(updateData).where(eq(jobs.id, id));
}

// Swarm Stats queries
export async function getOrCreateSwarmStats(userId: number): Promise<SwarmStats> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const existing = await db.select().from(swarmStats).where(eq(swarmStats.userId, userId)).limit(1);
  if (existing.length > 0) return existing[0];
  
  const result = await db.insert(swarmStats).values({ userId });
  const statsId = result[0].insertId;
  const created = await db.select().from(swarmStats).where(eq(swarmStats.id, statsId as number)).limit(1);
  return created[0];
}

export async function updateSwarmStats(userId: number, gpuHoursContributed: number, killTokensEarned: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  
  await db.update(swarmStats).set({
    gpuHoursContributed: gpuHoursContributed.toString(),
    killTokensEarned: killTokensEarned.toString(),
  }).where(eq(swarmStats.userId, userId));
}

// Studio Project queries
export async function createStudioProject(project: InsertStudioProject): Promise<StudioProject> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const result = await db.insert(studioProjects).values(project);
  const projectId = result[0].insertId;
  const created = await db.select().from(studioProjects).where(eq(studioProjects.id, projectId as number)).limit(1);
  return created[0];
}

export async function getUserStudioProjects(userId: number): Promise<StudioProject[]> {
  const db = await getDb();
  if (!db) return [];
  
  return db.select().from(studioProjects).where(eq(studioProjects.userId, userId)).orderBy(desc(studioProjects.updatedAt));
}

export async function updateStudioProject(id: number, updates: Partial<InsertStudioProject>): Promise<void> {
  const db = await getDb();
  if (!db) return;
  
  await db.update(studioProjects).set(updates).where(eq(studioProjects.id, id));
}

// Capture Reconstruction queries
export async function createCaptureReconstruction(reconstruction: InsertCaptureReconstruction): Promise<CaptureReconstruction> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const result = await db.insert(captureReconstructions).values(reconstruction);
  const reconstructionId = result[0].insertId;
  const created = await db.select().from(captureReconstructions).where(eq(captureReconstructions.id, reconstructionId as number)).limit(1);
  return created[0];
}

export async function getUserCaptureReconstructions(userId: number): Promise<CaptureReconstruction[]> {
  const db = await getDb();
  if (!db) return [];
  
  return db.select().from(captureReconstructions).where(eq(captureReconstructions.userId, userId)).orderBy(desc(captureReconstructions.createdAt));
}

export async function updateCaptureReconstructionStatus(id: number, status: CaptureReconstruction["status"], reconstructionData?: unknown, errorMessage?: string | null): Promise<void> {
  const db = await getDb();
  if (!db) return;
  
  const updateData: Record<string, unknown> = { status };
  if (reconstructionData !== undefined) updateData.reconstructionData = reconstructionData;
  if (errorMessage !== undefined) updateData.errorMessage = errorMessage;
  if (status === "complete" || status === "failed") {
    updateData.completedAt = new Date();
  }
  
  await db.update(captureReconstructions).set(updateData).where(eq(captureReconstructions.id, id));
}

// Swarm Node queries
export async function registerSwarmNode(node: InsertSwarmNode): Promise<SwarmNode> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const result = await db.insert(swarmNodes).values(node);
  const nodeId = result[0].insertId;
  const created = await db.select().from(swarmNodes).where(eq(swarmNodes.id, nodeId as number)).limit(1);
  return created[0];
}

export async function getUserSwarmNodes(userId: number): Promise<SwarmNode[]> {
  const db = await getDb();
  if (!db) return [];
  
  return db.select().from(swarmNodes).where(eq(swarmNodes.userId, userId));
}

export async function updateSwarmNodeStatus(nodeId: string, status: SwarmNode["status"]): Promise<void> {
  const db = await getDb();
  if (!db) return;
  
  await db.update(swarmNodes).set({ status, lastHeartbeat: new Date() }).where(eq(swarmNodes.nodeId, nodeId));
}

// Training Job queries
export async function createTrainingJob(job: InsertTrainingJob): Promise<TrainingJob> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const result = await db.insert(trainingJobs).values(job);
  const jobId = result[0].insertId;
  const created = await db.select().from(trainingJobs).where(eq(trainingJobs.id, jobId as number)).limit(1);
  return created[0];
}

export async function getTrainingJobById(id: number): Promise<TrainingJob | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db.select().from(trainingJobs).where(eq(trainingJobs.id, id)).limit(1);
  return result[0];
}

export async function updateTrainingJobStatus(id: number, status: TrainingJob["status"], progress?: number, errorMessage?: string | null): Promise<void> {
  const db = await getDb();
  if (!db) return;
  
  const updateData: Record<string, unknown> = { status };
  if (progress !== undefined) updateData.progress = progress;
  if (errorMessage !== undefined) updateData.errorMessage = errorMessage;
  if (status === "complete" || status === "failed") {
    updateData.completedAt = new Date();
  }
  
  await db.update(trainingJobs).set(updateData).where(eq(trainingJobs.id, id));
}

// Camera Control queries
export async function createCameraControl(control: InsertCameraControl): Promise<CameraControl> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const result = await db.insert(cameraControls).values(control);
  const controlId = result[0].insertId;
  const created = await db.select().from(cameraControls).where(eq(cameraControls.id, controlId as number)).limit(1);
  return created[0];
}

export async function getVideoCameraControls(videoId: number): Promise<CameraControl[]> {
  const db = await getDb();
  if (!db) return [];
  
  return db.select().from(cameraControls).where(eq(cameraControls.videoId, videoId));
}


export async function getStudioProjectById(id: number): Promise<StudioProject | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db.select().from(studioProjects).where(eq(studioProjects.id, id)).limit(1);
  return result[0];
}

export async function deleteVideo(id: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  
  await db.delete(videos).where(eq(videos.id, id));
}

export async function getCaptureReconstructionById(id: number): Promise<CaptureReconstruction | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db.select().from(captureReconstructions).where(eq(captureReconstructions.id, id)).limit(1);
  return result[0];
}
