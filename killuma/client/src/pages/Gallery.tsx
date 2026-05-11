'use client';

import { useState, useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Loader2, Trash2, Download, Play } from 'lucide-react';

interface Video {
  id: number;
  title: string;
  prompt: string;
  videoUrl: string;
  status: string;
  createdAt: Date;
}

export default function Gallery() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<Video | null>(null);
  const [page, setPage] = useState(1);
  const [isDeleting, setIsDeleting] = useState(false);

  const galleryQuery = trpc.gallery.getVideos.useQuery({ page, limit: 12 });
  const deleteVideoMutation = trpc.gallery.deleteVideo.useMutation();

  useEffect(() => {
    if (galleryQuery.data) {
      setVideos(galleryQuery.data as Video[]);
    }
  }, [galleryQuery.data]);

  const handleDeleteVideo = async (videoId: number) => {
    if (!confirm("Delete this video?")) return;
    
    setIsDeleting(true);
    try {
      await deleteVideoMutation.mutateAsync({ videoId });
      setVideos(videos.filter(v => v.id !== videoId));
      galleryQuery.refetch();
    } catch (e) {
      console.error("Failed to delete video", e);
    }
    setIsDeleting(false);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-6">
      <div className="max-w-7xl mx-auto">
        <div className="mb-12">
          <h1 className="text-5xl font-black tracking-tighter mb-2 text-red-600">GALLERY</h1>
          <p className="text-lg text-zinc-400">Your generated videos. Replay, download, and manage.</p>
        </div>

        {videos.length === 0 ? (
          <div className="text-center py-20">
            <Loader2 className="animate-spin mx-auto mb-4" size={48} />
            <p className="text-zinc-400 text-lg">No videos generated yet. Head to Kill Mode to create your first victim.</p>
          </div>
        ) : (
          <>
            {/* Video Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
              {videos.map(video => (
                <div
                  key={video.id}
                  className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden hover:border-red-600 transition-all cursor-pointer group"
                  onClick={() => setSelectedVideo(video)}
                >
                  {/* Thumbnail */}
                  <div className="relative bg-zinc-800 aspect-video flex items-center justify-center overflow-hidden">
                    {video.videoUrl ? (
                      <>
                        <video
                          src={video.videoUrl}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                          muted
                        />
                        <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-40 transition-all flex items-center justify-center">
                          <Play className="text-red-600 opacity-0 group-hover:opacity-100 transition-opacity" size={48} />
                        </div>
                      </>
                    ) : (
                      <div className="text-zinc-500 text-center">
                        <p className="text-sm">Processing...</p>
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="p-4">
                    <h3 className="font-bold text-lg mb-1 line-clamp-2">{video.title}</h3>
                    <p className="text-xs text-zinc-400 line-clamp-2 mb-3">{video.prompt}</p>
                    
                    <div className="flex items-center justify-between">
                      <span className={`text-xs font-bold px-2 py-1 rounded ${
                        video.status === 'complete'
                          ? 'bg-green-600 bg-opacity-20 text-green-600'
                          : video.status === 'processing'
                          ? 'bg-blue-600 bg-opacity-20 text-blue-600'
                          : 'bg-red-600 bg-opacity-20 text-red-600'
                      }`}>
                        {video.status.toUpperCase()}
                      </span>
                      <p className="text-xs text-zinc-500">
                        {new Date(video.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            <div className="flex justify-center gap-4 mb-12">
              <Button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                variant="outline"
                className="border-zinc-700 text-white hover:bg-zinc-800"
              >
                Previous
              </Button>
              <span className="flex items-center text-zinc-400">Page {page}</span>
              <Button
                onClick={() => setPage(page + 1)}
                disabled={videos.length < 12}
                variant="outline"
                className="border-zinc-700 text-white hover:bg-zinc-800"
              >
                Next
              </Button>
            </div>
          </>
        )}

        {/* Video Player Modal */}
        {selectedVideo && (
          <div
            className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center p-6 z-50"
            onClick={() => setSelectedVideo(null)}
          >
            <div
              className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-4xl w-full max-h-96 flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between p-6 border-b border-zinc-800">
                <h3 className="text-xl font-bold">{selectedVideo.title}</h3>
                <button
                  onClick={() => setSelectedVideo(null)}
                  className="text-zinc-400 hover:text-white"
                >
                  ✕
                </button>
              </div>

              <div className="flex-1 flex flex-col">
                {selectedVideo.videoUrl ? (
                  <video
                    src={selectedVideo.videoUrl}
                    controls
                    autoPlay
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <p className="text-zinc-400">Video not available</p>
                  </div>
                )}
              </div>

              <div className="p-6 border-t border-zinc-800">
                <p className="text-sm text-zinc-400 mb-4">{selectedVideo.prompt}</p>
                <div className="flex gap-3">
                  {selectedVideo.videoUrl && (
                    <Button
                      onClick={() => {
                        const a = document.createElement('a');
                        a.href = selectedVideo.videoUrl;
                        a.download = `${selectedVideo.title}.mp4`;
                        a.click();
                      }}
                      className="flex-1 bg-green-600 hover:bg-green-700"
                    >
                      <Download size={16} className="mr-2" />
                      Download
                    </Button>
                  )}
                  <Button
                    onClick={() => {
                      handleDeleteVideo(selectedVideo.id);
                      setSelectedVideo(null);
                    }}
                    disabled={isDeleting}
                    className="flex-1 bg-red-600 hover:bg-red-700"
                  >
                    <Trash2 size={16} className="mr-2" />
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
