# Killuma - Kill Mode Project TODO

## Database & Schema
- [x] Create videos table (id, userId, title, prompt, status, videoUrl, createdAt, updatedAt)
- [x] Create jobs table (id, videoId, status, progress, errorMessage, createdAt, completedAt)
- [x] Create swarmStats table (id, userId, gpuHoursContributed, killTokensEarned, lastUpdated)
- [x] Create studioProjects table (id, userId, title, timelineData, motionBrushData, cameraPathData)
- [x] Create captureReconstructions table (id, userId, inputVideoUrl, reconstructionData, status)
- [x] Create swarmNodes table (id, userId, nodeId, gpuModel, gpuMemoryGb, status)
- [x] Create trainingJobs table (id, jobId, modelType, status, datasetSize, nodeIds)
- [x] Create cameraControls table (id, videoId, controlType, startFrame, endFrame, intensity, conditioningData)
- [x] Run Drizzle migrations to apply schema

## Authentication & Authorization
- [ ] Implement protected routes for Studio, Capture, Swarm pages
- [ ] Verify Manus OAuth integration works correctly
- [ ] Add role-based access control if needed
- [ ] Test login/logout flow

## Kill Mode Page (Text-to-Video)
- [x] Create Kill Mode page component
- [x] Build textarea input for video prompt
- [x] Implement API endpoint for video generation request
- [x] Add real-time status polling (deploying → processing → complete/failed)
- [x] Display status feedback in UI
- [x] Show generated video in-page once complete
- [x] Handle error states and retry logic
- [x] Match page.tsx aesthetic (zinc-950 bg, red-600 accent, bold typography)

## Image-to-Video Feature
- [x] Create Image-to-Video page component
- [x] Add image upload input
- [x] Add text prompt input
- [x] Implement API endpoint for image-to-video generation
- [x] Display uploaded image preview
- [x] Show status polling and generated video
- [x] Store reference image in S3

## Studio Page (Timeline Editor)
- [x] Create Studio page layout
- [x] Build timeline editor UI component
- [x] Implement motion brush controls
- [x] Implement camera path controls
- [x] Implement clip extension options
- [x] Add save/export functionality
- [x] Connect to backend for persistence

## Capture Page (3D Scene Reconstruction)
- [x] Create Capture page component
- [x] Add video upload input
- [x] Implement API endpoint for 3D reconstruction
- [x] Build 3D Gaussian splat / NeRF-style preview component
- [x] Add status polling for reconstruction
- [x] Store uploaded video in S3

## Swarm Training Dashboard
- [x] Create Swarm Training page component
- [x] Display GPU contribution stats
- [x] Display $KILL token rewards
- [x] Build node dashboard UI
- [x] Implement real-time stats updates
- [x] Add contribution history

## Video Gallery
- [ ] Create gallery page component
- [ ] Display per-user generated videos
- [ ] Add video replay functionality
- [ ] Implement pagination/infinite scroll
- [ ] Add delete/manage video options
- [ ] Show video metadata (prompt, date, status)

## File Storage Integration
- [ ] Implement S3 upload for reference images
- [ ] Implement S3 upload for input videos
- [ ] Implement S3 upload for generated videos
- [ ] Add presigned URL generation for downloads
- [ ] Handle file cleanup/deletion

## Job Queue & Status Polling
- [ ] Create job queue table and model
- [ ] Implement background job processor
- [ ] Add status polling endpoint
- [ ] Implement WebSocket or polling for real-time updates
- [ ] Handle job timeout and retry logic
- [ ] Track full lifecycle: deploying → processing → complete/failed

## UI/UX & Styling
- [ ] Ensure consistent dark theme (zinc-950 backgrounds)
- [ ] Apply red-600 accent colors throughout
- [ ] Use bold oversized typography matching page.tsx
- [ ] Add loading states and spinners
- [ ] Add error messages and toast notifications
- [ ] Implement responsive design

## Testing
- [ ] Write vitest tests for API endpoints
- [ ] Write vitest tests for database queries
- [ ] Write vitest tests for job status logic
- [ ] Test authentication flows
- [ ] Test file upload/storage flows

## Navigation & Routing
- [x] Set up routes for all pages
- [x] Create main navigation menu
- [x] Add breadcrumbs or navigation context
- [ ] Implement protected route guards
- [x] Add 404 and error pages

## Deployment & Final
- [ ] Review all features for completeness
- [ ] Test full user flows end-to-end
- [ ] Create checkpoint
- [ ] Prepare for deployment
