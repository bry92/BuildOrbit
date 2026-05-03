'use client';

import { useState, useRef, useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Loader2, Upload } from 'lucide-react';

interface ReconstructionData {
  pointCloud?: { points: number[][] };
  gaussianSplats?: { positions: number[][] };
  nerf?: { bounds: number[] };
}

export default function Capture() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [status, setStatus] = useState("Ready to capture.");
  const [isProcessing, setIsProcessing] = useState(false);
  const [reconstructionId, setReconstructionId] = useState<number | null>(null);
  const [reconstructionData, setReconstructionData] = useState<ReconstructionData | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const uploadVideoMutation = trpc.capture.uploadVideo.useMutation();
  const statusQuery = trpc.capture.getStatus.useQuery(
    { reconstructionId: reconstructionId || 0 },
    { enabled: reconstructionId !== null && isProcessing, refetchInterval: 2000 }
  );

  useEffect(() => {
    if (statusQuery.data) {
      const newStatus = statusQuery.data.status;
      
      if (newStatus === "processing") {
        setStatus("Processing 3D reconstruction...");
      } else if (newStatus === "complete") {
        setStatus("Reconstruction complete.");
        if (statusQuery.data.reconstructionData) {
          setReconstructionData(statusQuery.data.reconstructionData as ReconstructionData);
          renderReconstruction(statusQuery.data.reconstructionData as ReconstructionData);
        }
        setIsProcessing(false);
      } else if (newStatus === "failed") {
        setStatus("Reconstruction failed. Try again.");
        setIsProcessing(false);
      }
    }
  }, [statusQuery.data]);

  const renderReconstruction = (data: ReconstructionData) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.fillStyle = '#18181b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw placeholder visualization
    ctx.fillStyle = '#dc2626';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('3D Gaussian Splat / NeRF Reconstruction', 20, 40);

    // Draw some sample points if available
    if (data.pointCloud?.points) {
      ctx.fillStyle = '#60a5fa';
      data.pointCloud.points.slice(0, 100).forEach(point => {
        const x = (point[0] + 1) * (canvas.width / 2);
        const y = (point[1] + 1) * (canvas.height / 2);
        ctx.fillRect(x, y, 2, 2);
      });
    }
  };

  const handleVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setVideoFile(file);
    setStatus("Video selected. Ready to process.");
  };

  const executeCapture = async () => {
    if (!videoFile) return;
    
    setIsProcessing(true);
    setStatus("Processing 3D reconstruction...");

    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const base64 = event.target?.result as string;
        const base64Data = base64.split(',')[1];

        try {
          const result = await uploadVideoMutation.mutateAsync({
            videoData: base64Data,
            filename: videoFile.name,
          });
          setReconstructionId(result.reconstructionId);
        } catch (e) {
          setStatus("Upload failed. Try again.");
          setIsProcessing(false);
        }
      };
      reader.readAsDataURL(videoFile);
    } catch (e) {
      setStatus("Capture failed. Try again.");
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center p-6">
      <div className="max-w-4xl w-full">
        <h1 className="text-7xl font-black tracking-tighter mb-2 text-red-600">CAPTURE</h1>
        <p className="text-xl mb-12 text-zinc-400">Upload video → 3D Gaussian Splat / NeRF reconstruction.</p>

        <div className="grid grid-cols-2 gap-8">
          {/* Upload Section */}
          <div>
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-zinc-700 rounded-xl p-12 cursor-pointer hover:border-red-600 transition-colors flex flex-col items-center justify-center min-h-64 bg-zinc-900"
            >
              {videoFile ? (
                <>
                  <p className="text-lg font-bold text-green-600">{videoFile.name}</p>
                  <p className="text-sm text-zinc-400 mt-2">{(videoFile.size / 1024 / 1024).toFixed(2)} MB</p>
                </>
              ) : (
                <>
                  <Upload className="mb-4 text-zinc-500" size={48} />
                  <p className="text-lg font-bold">Click to upload video</p>
                  <p className="text-sm text-zinc-500 mt-2">MP4, WebM, or MOV</p>
                </>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              onChange={handleVideoUpload}
              className="hidden"
            />

            <Button
              onClick={executeCapture}
              disabled={isProcessing || !videoFile}
              className="mt-8 w-full py-8 bg-red-600 hover:bg-red-700 disabled:bg-zinc-800 text-2xl font-bold tracking-wider transition-all active:scale-95 rounded-2xl"
            >
              {isProcessing ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="animate-spin" size={28} />
                  PROCESSING...
                </span>
              ) : (
                "CAPTURE 3D"
              )}
            </Button>

            <p className="text-center mt-6 text-zinc-500 text-sm">{status}</p>
          </div>

          {/* Preview Section */}
          <div>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 min-h-64 flex flex-col">
              <h3 className="text-lg font-bold mb-4 text-red-600">3D Reconstruction Preview</h3>
              <canvas
                ref={canvasRef}
                width={400}
                height={300}
                className="bg-zinc-800 rounded border border-zinc-700 flex-1"
              />
              {reconstructionData && (
                <div className="mt-4 text-sm text-zinc-400">
                  <p>✓ Reconstruction complete</p>
                  {reconstructionData.pointCloud && <p>✓ Point cloud generated</p>}
                  {reconstructionData.gaussianSplats && <p>✓ Gaussian splats computed</p>}
                  {reconstructionData.nerf && <p>✓ NeRF model ready</p>}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Info Section */}
        <div className="mt-12 bg-zinc-900 border border-zinc-800 rounded-xl p-6">
          <h3 className="text-lg font-bold mb-4 text-red-600">How It Works</h3>
          <ul className="space-y-2 text-sm text-zinc-400">
            <li>• Upload a video from your phone or camera</li>
            <li>• AI extracts 3D scene geometry using 3D Gaussian Splatting</li>
            <li>• Generate NeRF-style novel view synthesis</li>
            <li>• Export as point cloud or mesh for further editing</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
