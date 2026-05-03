'use client';

import { useState, useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

export default function KillMode() {
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("Ready to kill.");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isKilling, setIsKilling] = useState(false);
  const [videoId, setVideoId] = useState<number | null>(null);
  const [statusSequence, setStatusSequence] = useState<"deploying" | "processing" | "complete" | "failed" | null>(null);

  const generateMutation = trpc.killMode.generate.useMutation();
  const statusQuery = trpc.killMode.getStatus.useQuery(
    { videoId: videoId || 0 },
    { enabled: videoId !== null && isKilling, refetchInterval: 2000 }
  );

  useEffect(() => {
    if (statusQuery.data) {
      const newStatus = statusQuery.data.status;
      setStatusSequence(newStatus);
      
      if (newStatus === "deploying") {
        setStatus("Deploying assassins...");
      } else if (newStatus === "processing") {
        setStatus(`Processing... ${statusQuery.data.progress || 0}%`);
      } else if (newStatus === "complete") {
        setStatus("Victim eliminated.");
        if (statusQuery.data.videoUrl) {
          setVideoUrl(statusQuery.data.videoUrl);
        }
        setIsKilling(false);
      } else if (newStatus === "failed") {
        setStatus("Kill failed. Try again.");
        setIsKilling(false);
      }
    }
  }, [statusQuery.data]);

  const executeKill = async () => {
    if (!prompt.trim()) return;
    
    setIsKilling(true);
    setVideoUrl(null);
    setStatusSequence(null);
    setStatus("Deploying assassins...");

    try {
      const result = await generateMutation.mutateAsync({ prompt });
      setVideoId(result.videoId);
    } catch (e) {
      setStatus("Kill failed. Try again.");
      setIsKilling(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center p-6">
      <div className="max-w-xl w-full">
        <h1 className="text-7xl font-black tracking-tighter mb-2 text-red-600">KILLUMA</h1>
        <p className="text-xl mb-12 text-zinc-400">Luma is dead. Long live the slaughter.</p>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the victim... 
A cyberpunk samurai slicing through a raining neon street, dramatic camera pan, cinematic lighting"
          className="w-full h-52 bg-zinc-900 border border-zinc-800 rounded-xl p-6 text-lg placeholder-zinc-500 focus:outline-none focus:border-red-600 resize-none"
        />

        <Button
          onClick={executeKill}
          disabled={isKilling || !prompt.trim()}
          className="mt-8 w-full py-8 bg-red-600 hover:bg-red-700 disabled:bg-zinc-800 text-3xl font-bold tracking-wider transition-all active:scale-95 rounded-2xl"
        >
          {isKilling ? (
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
