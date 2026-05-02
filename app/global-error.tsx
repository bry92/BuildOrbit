'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-white mb-4">Something went wrong!</h2>
        <button onClick={() => reset()} className="bg-cyan-500 text-white px-6 py-2 rounded-lg">
          Try again
        </button>
      </div>
    </div>
  );
}
