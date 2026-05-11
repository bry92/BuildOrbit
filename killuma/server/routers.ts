import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";
import { storagePut } from "./storage";
import { TRPCError } from "@trpc/server";


export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // Kill Mode - Text-to-Video
  killMode: router({
    generate: protectedProcedure
      .input(z.object({
        prompt: z.string().min(10).max(2000),
        title: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // Create video record with deploying status
        const video = await db.createVideo({
          userId: ctx.user.id,
          prompt: input.prompt,
          title: input.title,
          status: "deploying",
        });

        // Create associated job
        await db.createJob({
          videoId: video.id,
          status: "deploying",
          progress: 0,
        });

        return {
          videoId: video.id,
          status: "deploying",
        };
      }),

    getStatus: protectedProcedure
      .input(z.object({ videoId: z.number() }))
      .query(async ({ input, ctx }) => {
        const video = await db.getVideoById(input.videoId);
        if (!video || video.userId !== ctx.user.id) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }

        const job = await db.getJobByVideoId(input.videoId);
        return {
          videoId: video.id,
          status: video.status,
          progress: job?.progress ?? 0,
          videoUrl: video.videoUrl,
          errorMessage: video.errorMessage,
        };
      }),

    getGallery: protectedProcedure
      .input(z.object({
        limit: z.number().default(20),
        offset: z.number().default(0),
      }))
      .query(async ({ input, ctx }) => {
        const videos = await db.getUserVideos(ctx.user.id, input.limit, input.offset);
        return videos.map(v => ({
          id: v.id,
          title: v.title,
          prompt: v.prompt,
          status: v.status,
          videoUrl: v.videoUrl,
          createdAt: v.createdAt,
        }));
      }),
  }),

  // Image-to-Video
  imageToVideo: router({
    generate: protectedProcedure
      .input(z.object({
        prompt: z.string().min(10).max(2000),
        imageUrl: z.string().url(),
        title: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // Create video record with reference image
        const video = await db.createVideo({
          userId: ctx.user.id,
          prompt: input.prompt,
          title: input.title,
          referenceImageUrl: input.imageUrl,
          status: "deploying",
        });

        // Create associated job
        await db.createJob({
          videoId: video.id,
          status: "deploying",
          progress: 0,
        });

        return {
          videoId: video.id,
          status: "deploying",
        };
      }),

    uploadImage: protectedProcedure
      .input(z.object({
        imageData: z.string(), // base64
        filename: z.string(),
      }))
      .mutation(async ({ input, ctx }) => {
        const buffer = Buffer.from(input.imageData, "base64");
        const { url, key } = await storagePut(
          `${ctx.user.id}-images/${input.filename}`,
          buffer,
          "image/jpeg"
        );
        return { url, key };
      }),
  }),

  // Studio - Timeline Editor
  studio: router({
    createProject: protectedProcedure
      .input(z.object({
        title: z.string().min(1).max(255),
      }))
      .mutation(async ({ input, ctx }) => {
        const project = await db.createStudioProject({
          userId: ctx.user.id,
          title: input.title,
        });
        return project;
      }),

    getProjects: protectedProcedure
      .query(async ({ ctx }) => {
        return db.getUserStudioProjects(ctx.user.id);
      }),

    updateProject: protectedProcedure
      .input(z.object({
        projectId: z.number(),
        title: z.string().optional(),
        timelineData: z.unknown().optional(),
        motionBrushData: z.unknown().optional(),
        cameraPathData: z.unknown().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const project = await db.getStudioProjectById(input.projectId);
        if (!project || project.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        await db.updateStudioProject(input.projectId, {
          title: input.title,
          timelineData: input.timelineData,
          motionBrushData: input.motionBrushData,
          cameraPathData: input.cameraPathData,
        });

        return { success: true };
      }),

    addCameraControl: protectedProcedure
      .input(z.object({
        videoId: z.number(),
        controlType: z.enum(["pan", "zoom", "rotation", "dolly", "orbit"]),
        startFrame: z.number(),
        endFrame: z.number(),
        intensity: z.number().default(1.0),
        easing: z.enum(["linear", "easeIn", "easeOut", "easeInOut"]).default("linear"),
        conditioningData: z.unknown().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // Verify user owns the video
        const video = await db.getVideoById(input.videoId);
        if (!video || video.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        const control = await db.createCameraControl({
          videoId: input.videoId,
          controlType: input.controlType,
          startFrame: input.startFrame,
          endFrame: input.endFrame,
          intensity: input.intensity.toString(),
          easing: input.easing,
          conditioningData: input.conditioningData,
        });

        return control;
      }),
  }),

  // Capture - 3D Scene Reconstruction
  capture: router({
    uploadVideo: protectedProcedure
      .input(z.object({
        videoData: z.string(), // base64
        filename: z.string(),
      }))
      .mutation(async ({ input, ctx }) => {
        const buffer = Buffer.from(input.videoData, "base64");
        const { url, key } = await storagePut(
          `${ctx.user.id}-captures/${input.filename}`,
          buffer,
          "video/mp4"
        );

        // Create reconstruction record
        const reconstruction = await db.createCaptureReconstruction({
          userId: ctx.user.id,
          inputVideoUrl: url,
          inputVideoKey: key,
          status: "processing",
        });

        return {
          reconstructionId: reconstruction.id,
          status: "processing",
        };
      }),

    getStatus: protectedProcedure
      .input(z.object({ reconstructionId: z.number() }))
      .query(async ({ input, ctx }) => {
        const reconstruction = await db.getCaptureReconstructionById(input.reconstructionId);
        
        if (!reconstruction || reconstruction.userId !== ctx.user.id) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }

        return {
          reconstructionId: reconstruction.id,
          status: reconstruction.status,
          reconstructionData: reconstruction.reconstructionData,
          errorMessage: reconstruction.errorMessage,
        };
      }),

    getReconstructions: protectedProcedure
      .query(async ({ ctx }) => {
        return db.getUserCaptureReconstructions(ctx.user.id);
      }),
  }),

  // Swarm Training
  swarm: router({
    getStats: protectedProcedure
      .query(async ({ ctx }) => {
        const stats = await db.getOrCreateSwarmStats(ctx.user.id);
        return {
          gpuHoursContributed: parseFloat(stats.gpuHoursContributed as unknown as string),
          killTokensEarned: parseFloat(stats.killTokensEarned as unknown as string),
        };
      }),

    registerNode: protectedProcedure
      .input(z.object({
        gpuModel: z.string(),
        gpuMemoryGb: z.number(),
      }))
      .mutation(async ({ input, ctx }) => {
        const nodeId = `node-${ctx.user.id}-${Date.now()}`;
        const node = await db.registerSwarmNode({
          userId: ctx.user.id,
          nodeId,
          gpuModel: input.gpuModel,
          gpuMemoryGb: input.gpuMemoryGb,
          status: "online",
        });

        return {
          nodeId: node.nodeId,
          status: "online",
        };
      }),

    getNodes: protectedProcedure
      .query(async ({ ctx }) => {
        return db.getUserSwarmNodes(ctx.user.id);
      }),

    updateNodeStatus: protectedProcedure
      .input(z.object({
        nodeId: z.string(),
        status: z.enum(["online", "offline", "training"]),
      }))
      .mutation(async ({ input, ctx }) => {
        const nodes = await db.getUserSwarmNodes(ctx.user.id);
        const node = nodes.find(n => n.nodeId === input.nodeId);
        
        if (!node) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }

        await db.updateSwarmNodeStatus(input.nodeId, input.status);
        return { success: true };
      }),
  }),

  // Gallery - Video Management
  gallery: router({
    getVideos: protectedProcedure
      .input(z.object({
        page: z.number().default(1),
        limit: z.number().default(12),
      }))
      .query(async ({ input, ctx }) => {
        const offset = (input.page - 1) * input.limit;
        return db.getUserVideos(ctx.user.id, input.limit, offset);
      }),

    deleteVideo: protectedProcedure
      .input(z.object({ videoId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const video = await db.getVideoById(input.videoId);
        if (!video || video.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }

        await db.deleteVideo(input.videoId);
        return { success: true };
      }),
  }),
});

export type AppRouter = typeof appRouter;

// Add camera controls router to studio
export async function getVideoCameraControls(videoId: number) {
  return db.getVideoCameraControls(videoId);
}
