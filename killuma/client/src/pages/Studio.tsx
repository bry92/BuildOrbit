'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Loader2, Plus, Trash2 } from 'lucide-react';

interface TimelineClip {
  id: string;
  startFrame: number;
  endFrame: number;
  label: string;
}

interface MotionBrush {
  id: string;
  x: number;
  y: number;
  intensity: number;
  direction: string;
}

interface CameraPath {
  id: string;
  type: 'pan' | 'zoom' | 'rotation' | 'dolly' | 'orbit';
  startFrame: number;
  endFrame: number;
  intensity: number;
}

export default function Studio() {
  const [projectTitle, setProjectTitle] = useState("Untitled Project");
  const [clips, setClips] = useState<TimelineClip[]>([]);
  const [motionBrushes, setMotionBrushes] = useState<MotionBrush[]>([]);
  const [cameraPaths, setCameraPaths] = useState<CameraPath[]>([]);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [timelineLength, setTimelineLength] = useState(300);
  const [selectedTool, setSelectedTool] = useState<'brush' | 'camera' | 'clip' | null>(null);

  const createProjectMutation = trpc.studio.createProject.useMutation();
  const updateProjectMutation = trpc.studio.updateProject.useMutation();
  const getProjectsQuery = trpc.studio.getProjects.useQuery();

  const handleAddClip = () => {
    const newClip: TimelineClip = {
      id: `clip-${Date.now()}`,
      startFrame: currentFrame,
      endFrame: currentFrame + 30,
      label: `Clip ${clips.length + 1}`,
    };
    setClips([...clips, newClip]);
  };

  const handleAddMotionBrush = () => {
    const newBrush: MotionBrush = {
      id: `brush-${Date.now()}`,
      x: 0.5,
      y: 0.5,
      intensity: 1.0,
      direction: 'right',
    };
    setMotionBrushes([...motionBrushes, newBrush]);
  };

  const handleAddCameraPath = () => {
    const newPath: CameraPath = {
      id: `camera-${Date.now()}`,
      type: 'pan',
      startFrame: currentFrame,
      endFrame: currentFrame + 60,
      intensity: 1.0,
    };
    setCameraPaths([...cameraPaths, newPath]);
  };

  const handleSaveProject = async () => {
    try {
      await updateProjectMutation.mutateAsync({
        projectId: 1, // TODO: Get actual project ID
        title: projectTitle,
        timelineData: { clips, currentFrame, timelineLength },
        motionBrushData: motionBrushes,
        cameraPathData: cameraPaths,
      });
    } catch (e) {
      console.error("Failed to save project", e);
    }
  };

  const handleDeleteClip = (id: string) => {
    setClips(clips.filter(c => c.id !== id));
  };

  const handleDeleteBrush = (id: string) => {
    setMotionBrushes(motionBrushes.filter(b => b.id !== id));
  };

  const handleDeleteCamera = (id: string) => {
    setCameraPaths(cameraPaths.filter(c => c.id !== id));
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-6">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-5xl font-black tracking-tighter mb-2 text-red-600">STUDIO</h1>
          <p className="text-lg text-zinc-400">Timeline editor with motion brush, camera controls, and clip extension.</p>
        </div>

        {/* Project Title */}
        <div className="mb-6">
          <input
            type="text"
            value={projectTitle}
            onChange={(e) => setProjectTitle(e.target.value)}
            className="text-3xl font-bold bg-transparent border-b-2 border-zinc-700 focus:border-red-600 outline-none text-white w-full pb-2"
            placeholder="Project Title"
          />
        </div>

        {/* Toolbar */}
        <div className="flex gap-4 mb-8 flex-wrap">
          <Button
            onClick={handleAddClip}
            variant={selectedTool === 'clip' ? 'default' : 'outline'}
            className={selectedTool === 'clip' ? 'bg-red-600' : ''}
          >
            <Plus size={16} className="mr-2" /> Add Clip
          </Button>
          <Button
            onClick={handleAddMotionBrush}
            variant={selectedTool === 'brush' ? 'default' : 'outline'}
            className={selectedTool === 'brush' ? 'bg-red-600' : ''}
          >
            <Plus size={16} className="mr-2" /> Motion Brush
          </Button>
          <Button
            onClick={handleAddCameraPath}
            variant={selectedTool === 'camera' ? 'default' : 'outline'}
            className={selectedTool === 'camera' ? 'bg-red-600' : ''}
          >
            <Plus size={16} className="mr-2" /> Camera Path
          </Button>
          <Button onClick={handleSaveProject} className="bg-red-600 hover:bg-red-700 ml-auto">
            Save Project
          </Button>
        </div>

        {/* Timeline */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-8">
          <div className="mb-4">
            <label className="block text-sm font-bold text-zinc-300 mb-2">Timeline Length: {timelineLength} frames</label>
            <input
              type="range"
              min="100"
              max="1000"
              value={timelineLength}
              onChange={(e) => setTimelineLength(parseInt(e.target.value))}
              className="w-full"
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm font-bold text-zinc-300 mb-2">Current Frame: {currentFrame}</label>
            <input
              type="range"
              min="0"
              max={timelineLength}
              value={currentFrame}
              onChange={(e) => setCurrentFrame(parseInt(e.target.value))}
              className="w-full"
            />
          </div>

          {/* Timeline Visualization */}
          <div className="bg-zinc-800 rounded p-4 min-h-32 border border-zinc-700">
            <p className="text-zinc-400 text-sm mb-4">Timeline Tracks</p>
            
            {/* Clips Track */}
            {clips.length > 0 && (
              <div className="mb-4">
                <p className="text-xs font-bold text-zinc-400 mb-2">CLIPS ({clips.length})</p>
                <div className="flex gap-2 flex-wrap">
                  {clips.map(clip => (
                    <div
                      key={clip.id}
                      className="bg-red-600 bg-opacity-50 px-3 py-2 rounded text-xs font-bold flex items-center gap-2"
                    >
                      {clip.label} ({clip.startFrame}-{clip.endFrame})
                      <button
                        onClick={() => handleDeleteClip(clip.id)}
                        className="hover:bg-red-700 p-1 rounded"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Motion Brushes Track */}
            {motionBrushes.length > 0 && (
              <div className="mb-4">
                <p className="text-xs font-bold text-zinc-400 mb-2">MOTION BRUSHES ({motionBrushes.length})</p>
                <div className="flex gap-2 flex-wrap">
                  {motionBrushes.map(brush => (
                    <div
                      key={brush.id}
                      className="bg-blue-600 bg-opacity-50 px-3 py-2 rounded text-xs font-bold flex items-center gap-2"
                    >
                      Brush ({brush.direction})
                      <button
                        onClick={() => handleDeleteBrush(brush.id)}
                        className="hover:bg-blue-700 p-1 rounded"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Camera Paths Track */}
            {cameraPaths.length > 0 && (
              <div>
                <p className="text-xs font-bold text-zinc-400 mb-2">CAMERA PATHS ({cameraPaths.length})</p>
                <div className="flex gap-2 flex-wrap">
                  {cameraPaths.map(path => (
                    <div
                      key={path.id}
                      className="bg-green-600 bg-opacity-50 px-3 py-2 rounded text-xs font-bold flex items-center gap-2"
                    >
                      {path.type} ({path.startFrame}-{path.endFrame})
                      <button
                        onClick={() => handleDeleteCamera(path.id)}
                        className="hover:bg-green-700 p-1 rounded"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {clips.length === 0 && motionBrushes.length === 0 && cameraPaths.length === 0 && (
              <p className="text-zinc-500 text-sm">Add clips, motion brushes, or camera paths to get started.</p>
            )}
          </div>
        </div>

        {/* Properties Panel */}
        <div className="grid grid-cols-3 gap-6">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
            <h3 className="text-lg font-bold mb-4 text-red-600">Clip Properties</h3>
            <p className="text-sm text-zinc-400">{clips.length} clips added</p>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
            <h3 className="text-lg font-bold mb-4 text-blue-600">Motion Brushes</h3>
            <p className="text-sm text-zinc-400">{motionBrushes.length} brushes added</p>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
            <h3 className="text-lg font-bold mb-4 text-green-600">Camera Controls</h3>
            <p className="text-sm text-zinc-400">{cameraPaths.length} paths added</p>
          </div>
        </div>
      </div>
    </div>
  );
}
