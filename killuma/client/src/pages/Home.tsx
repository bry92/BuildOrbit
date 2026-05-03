import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Loader2, Zap, Video, Palette, Box, Zap as SwarmIcon } from "lucide-react";
import { getLoginUrl } from "@/const";
import { useLocation } from "wouter";

/**
 * Kill Mode landing page with navigation to all features
 */
export default function Home() {
  let { user, loading, error, isAuthenticated, logout } = useAuth();
  const [, setLocation] = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <Loader2 className="animate-spin" size={48} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900 bg-opacity-50 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-black tracking-tighter text-red-600">KILLUMA</h1>
            <p className="text-sm text-zinc-400">AI Video Forge</p>
          </div>
          <div className="flex items-center gap-4">
            {isAuthenticated && user ? (
              <>
                <span className="text-sm text-zinc-400">{user.name || user.email}</span>
                <Button
                  onClick={() => logout()}
                  variant="outline"
                  className="text-white border-zinc-700 hover:bg-zinc-800"
                >
                  Logout
                </Button>
              </>
            ) : (
              <Button
                onClick={() => window.location.href = getLoginUrl()}
                className="bg-red-600 hover:bg-red-700"
              >
                Login
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="max-w-7xl mx-auto px-6 py-20">
        <div className="text-center mb-16">
          <h2 className="text-7xl font-black tracking-tighter mb-4 text-red-600">
            KILL MODE
          </h2>
          <p className="text-2xl text-zinc-300 mb-4">
            Cinematic AI video generation. Unhinged. Unfiltered. Unstoppable.
          </p>
          <p className="text-lg text-zinc-400">
            Text-to-video, image-to-video, 3D capture, timeline editing, and decentralized training.
          </p>
        </div>

        {/* Feature Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
          {/* Kill Mode */}
          <div
            onClick={() => setLocation("/kill-mode")}
            className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 cursor-pointer hover:border-red-600 hover:bg-zinc-800 transition-all group"
          >
            <Zap className="text-red-600 mb-4 group-hover:scale-110 transition-transform" size={40} />
            <h3 className="text-2xl font-bold mb-2 text-red-600">Kill Mode</h3>
            <p className="text-zinc-400 mb-4">
              One prompt → brutal cinematic output. Real-time status tracking and video playback.
            </p>
            <Button className="w-full bg-red-600 hover:bg-red-700">
              Launch Kill Mode
            </Button>
          </div>

          {/* Image-to-Video */}
          <div
            onClick={() => setLocation("/image-to-video")}
            className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 cursor-pointer hover:border-red-600 hover:bg-zinc-800 transition-all group"
          >
            <Video className="text-blue-600 mb-4 group-hover:scale-110 transition-transform" size={40} />
            <h3 className="text-2xl font-bold mb-2 text-blue-600">Image-to-Video</h3>
            <p className="text-zinc-400 mb-4">
              Upload reference image + prompt. AI respects your visual input for consistent results.
            </p>
            <Button className="w-full bg-blue-600 hover:bg-blue-700">
              Image-to-Video
            </Button>
          </div>

          {/* Studio */}
          <div
            onClick={() => setLocation("/studio")}
            className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 cursor-pointer hover:border-red-600 hover:bg-zinc-800 transition-all group"
          >
            <Palette className="text-purple-600 mb-4 group-hover:scale-110 transition-transform" size={40} />
            <h3 className="text-2xl font-bold mb-2 text-purple-600">Studio</h3>
            <p className="text-zinc-400 mb-4">
              Timeline editor with motion brush, camera controls, and clip extension tools.
            </p>
            <Button className="w-full bg-purple-600 hover:bg-purple-700">
              Open Studio
            </Button>
          </div>

          {/* Capture */}
          <div
            onClick={() => setLocation("/capture")}
            className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 cursor-pointer hover:border-red-600 hover:bg-zinc-800 transition-all group"
          >
            <Box className="text-green-600 mb-4 group-hover:scale-110 transition-transform" size={40} />
            <h3 className="text-2xl font-bold mb-2 text-green-600">Capture</h3>
            <p className="text-zinc-400 mb-4">
              Upload phone videos → 3D Gaussian Splat / NeRF scene reconstruction.
            </p>
            <Button className="w-full bg-green-600 hover:bg-green-700">
              3D Capture
            </Button>
          </div>

          {/* Swarm Training */}
          <div
            onClick={() => setLocation("/swarm")}
            className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 cursor-pointer hover:border-red-600 hover:bg-zinc-800 transition-all group"
          >
            <SwarmIcon className="text-yellow-600 mb-4 group-hover:scale-110 transition-transform" size={40} />
            <h3 className="text-2xl font-bold mb-2 text-yellow-600">Swarm Training</h3>
            <p className="text-zinc-400 mb-4">
              Decentralized GPU network. Contribute compute, earn $KILL tokens.
            </p>
            <Button className="w-full bg-yellow-600 hover:bg-yellow-700">
              Join Swarm
            </Button>
          </div>

          {/* Video Gallery */}
          <div
            onClick={() => setLocation("/kill-mode")}
            className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 cursor-pointer hover:border-red-600 hover:bg-zinc-800 transition-all group"
          >
            <Video className="text-red-600 mb-4 group-hover:scale-110 transition-transform" size={40} />
            <h3 className="text-2xl font-bold mb-2 text-red-600">Gallery</h3>
            <p className="text-zinc-400 mb-4">
              Browse your generated videos. Replay, download, and manage your creations.
            </p>
            <Button className="w-full bg-red-600 hover:bg-red-700">
              View Gallery
            </Button>
          </div>
        </div>

        {/* Features Section */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-12 mb-16">
          <h3 className="text-3xl font-bold mb-8 text-red-600">Core Features</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <h4 className="text-lg font-bold text-red-600 mb-2">Text-to-Video</h4>
              <p className="text-zinc-400">
                Generate cinematic videos from text prompts with real-time status tracking and job queue management.
              </p>
            </div>
            <div>
              <h4 className="text-lg font-bold text-red-600 mb-2">Image-to-Video</h4>
              <p className="text-zinc-400">
                Upload reference images to guide video generation. AI respects visual input for consistency.
              </p>
            </div>
            <div>
              <h4 className="text-lg font-bold text-red-600 mb-2">3D Reconstruction</h4>
              <p className="text-zinc-400">
                3D Gaussian Splatting and NeRF-style scene reconstruction from video uploads.
              </p>
            </div>
            <div>
              <h4 className="text-lg font-bold text-red-600 mb-2">Camera Control</h4>
              <p className="text-zinc-400">
                Advanced camera conditioning (pan, zoom, rotation, dolly, orbit) for precise control.
              </p>
            </div>
            <div>
              <h4 className="text-lg font-bold text-red-600 mb-2">Timeline Editor</h4>
              <p className="text-zinc-400">
                Motion brush controls, camera paths, and clip extension tools in a professional studio interface.
              </p>
            </div>
            <div>
              <h4 className="text-lg font-bold text-red-600 mb-2">Decentralized Training</h4>
              <p className="text-zinc-400">
                Join the swarm. Contribute GPU, earn $KILL tokens. Help train custom models.
              </p>
            </div>
          </div>
        </div>

        {/* CTA Section */}
        <div className="text-center">
          <h3 className="text-3xl font-bold mb-4 text-red-600">Ready to Kill?</h3>
          <p className="text-lg text-zinc-400 mb-8">
            {isAuthenticated ? "Start creating cinematic videos now." : "Login to get started."}
          </p>
          {isAuthenticated ? (
            <Button
              onClick={() => setLocation("/kill-mode")}
              className="bg-red-600 hover:bg-red-700 text-2xl px-12 py-8 font-bold tracking-wider"
            >
              EXECUTE KILL
            </Button>
          ) : (
            <Button
              onClick={() => window.location.href = getLoginUrl()}
              className="bg-red-600 hover:bg-red-700 text-2xl px-12 py-8 font-bold tracking-wider"
            >
              LOGIN TO START
            </Button>
          )}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-800 bg-zinc-900 bg-opacity-50 mt-20">
        <div className="max-w-7xl mx-auto px-6 py-8 text-center text-sm text-zinc-500">
          <p>Killuma © 2026 • We don't ask for permission. We generate.</p>
        </div>
      </footer>
    </div>
  );
}
