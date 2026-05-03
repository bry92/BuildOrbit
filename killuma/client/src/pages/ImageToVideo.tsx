'use client';

import { useState, useEffect, useRef } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Loader2, Upload } from 'lucide-react';

export default function ImageToVideo() {
  const [prompt, setPrompt] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [status, setStatus] = useState("Ready to kill with reference.");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [videoId, setVideoId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadImageMutation = trpc.imageToVideo.uploadImage.useMutation();
  const generateMutation = trpc.imageToVideo.generate.useMutation();
  const statusQuery = trpc.killMode.getStatus.useQuery(
    { videoId: videoId || 0 },
    { enabled: videoId !== null && isProcessing, refetchInterval: 2000 }
  );

  useEffect(() => {
    if (statusQuery.data) {
      const newStatus = statusQuery.data.status;
      
      if (newStatus === "deploying") {
        setStatus("Deploying assassins...");
      } else if (newStatus === "processing") {
        setStatus(`Processing... ${statusQuery.data.progress || 0}%`);
      } else if (newStatus === "complete") {
        setStatus("Victim eliminated.");
        if (statusQuery.data.videoUrl) {
          setVideoUrl(statusQuery.data.videoUrl);
        }
        setIsProcessing(false);
      } else if (newStatus === "failed") {
        setStatus("Kill failed. Try again.");
        setIsProcessing(false);
      }
    }
  }, [statusQuery.data]);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64 = event.target?.result as string;
      const base64Data = base64.split(',')[1];

      try {
        const result = await uploadImageMutation.mutateAsync({
          imageData: base64Data,
          filename: file.name,
        });
        setImageUrl(result.url);
        setImagePreview(base64);
      } catch (e) {
        setStatus("Image upload failed.");
      }
    };
    reader.readAsDataURL(file);
  };

  const executeKill = async () => {
    if (!prompt.trim() || !imageUrl) return;
    
    setIsProcessing(true);
    setVideoUrl(null);
    setStatus("Deploying assassins...");

    try {
      const result = await generateMutation.mutateAsync({
        prompt,
        imageUrl,
      });
      setVideoId(result.videoId);
    } catch (e) {
      setStatus("Kill failed. Try again.");
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center p-6">
      <div className="max-w-2xl w-full">
        <h1 className="text-7xl font-black tracking-tighter mb-2 text-red-600">IMAGE KILL</h1>
        <p className="text-xl mb-12 text-zinc-400">Feed the beast a reference, watch it slaughter.</p>

        <div className="grid grid-cols-2 gap-6 mb-8">
          {/* Image Upload */}
          <div>
            <label className="block text-sm font-bold mb-2 text-zinc-300">Reference Image</label>
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-zinc-700 rounded-xl p-8 cursor-pointer hover:border-red-600 transition-colors flex flex-col items-center justify-center min-h-48 bg-zinc-900"
            >
              {imagePreview ? (
                <img src={imagePreview} alt="preview" className="max-h-40 max-w-full rounded" />
              ) : (
                <>
                  <Upload className="mb-2 text-zinc-500" size={32} />
                  <p className="text-sm text-zinc-500">Click to upload image</p>
                </>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageUpload}
              className="hidden"
            />
          </div>

          {/* Prompt */}
          <div>
            <label className="block text-sm font-bold mb-2 text-zinc-300">Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what the reference should become..."
              className="w-full h-48 bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-sm placeholder-zinc-500 focus:outline-none focus:border-red-600 resize-none"
            />
          </div>
        </div>

        <Button
          onClick={executeKill}
          disabled={isProcessing || !prompt.trim() || !imageUrl}
          className="w-full py-8 bg-red-600 hover:bg-red-700 disabled:bg-zinc-800 text-3xl font-bold tracking-wider transition-all active:scale-95 rounded-2xl"
        >
          {isProcessing ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="animate-spin" size={32} />
              EXECUTING...
            </span>
          ) : (
            "EXECUTE KILL"
          )}
        </Button>

        <p className="text-center mt-6 text-zinc-500 text-sm">{status}</p>

        {videoUrl && (
          <div className="mt-12">
            <h3 className="text-xl mb-4 font-bold">Victim Rendered:</h3>
            <video src={videoUrl} controls className="w-full rounded-2xl border border-zinc-800" />
          </div>
        )}
      </div>
    </div>
  );
}
