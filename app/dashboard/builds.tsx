'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Build {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'planning' | 'scaffolding' | 'coding' | 'saving' | 'verifying' | 'completed' | 'failed';
  app_type: 'web' | 'mobile' | 'fullstack';
  complexity: 'simple' | 'moderate' | 'complex';
  progress_percentage: number;
  current_phase: number;
  total_phases: number;
  git_url?: string;
  download_url?: string;
  code_size_bytes?: number;
  credits_used: number;
  created_at: string;
  completed_at?: string;
}

export default function BuildsPage() {
  const [builds, setBuilds] = useState<Build[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'completed' | 'failed'>('all');

  useEffect(() => {
    fetchBuilds();
  }, [filter]);

  const fetchBuilds = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const query = filter !== 'all' ? `?status=${filter}` : '';
      const response = await fetch(`/api/v1/builds${query}`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch builds');
      }

      const data = await response.json();
      setBuilds(data.builds || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownload = async (buildId: string) => {
    try {
      const response = await fetch(`/api/v1/builds/${buildId}/download`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
      });

      if (!response.ok) {
        throw new Error('Download failed');
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `build-${buildId}.zip`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Download failed');
    }
  };

  const getStatusColor = (status: Build['status']) => {
    switch (status) {
      case 'completed':
        return 'bg-green-500/10 text-green-400 border-green-500/30';
      case 'failed':
        return 'bg-red-500/10 text-red-400 border-red-500/30';
      case 'pending':
      case 'planning':
      case 'scaffolding':
      case 'coding':
      case 'saving':
      case 'verifying':
        return 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30';
      default:
        return 'bg-slate-500/10 text-slate-400 border-slate-500/30';
    }
  };

  const getStatusLabel = (status: Build['status']) => {
    return status.charAt(0).toUpperCase() + status.slice(1);
  };

  const getAppTypeIcon = (type: Build['app_type']) => {
    switch (type) {
      case 'web':
        return '🌐';
      case 'mobile':
        return '📱';
      case 'fullstack':
        return '🏗️';
      default:
        return '📦';
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-slate-400">Loading builds...</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-3xl font-bold text-white">Your Builds</h2>
          <p className="text-slate-400 mt-1">{builds.length} total builds</p>
        </div>
        <Link
          href="/builder"
          className="bg-gradient-to-r from-cyan-500 to-blue-600 text-white px-6 py-3 rounded-lg font-bold hover:shadow-lg hover:shadow-cyan-500/50 transition"
        >
          ➕ New Build
        </Link>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-8">
        {(['all', 'pending', 'completed', 'failed'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-lg font-semibold transition ${
              filter === f
                ? 'bg-cyan-500 text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/50 text-red-400 px-4 py-3 rounded-lg mb-6">
          {error}
        </div>
      )}

      {/* Builds List */}
      {builds.length === 0 ? (
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-12 text-center">
          <div className="text-5xl mb-4">📭</div>
          <p className="text-slate-400 mb-6">No builds yet. Create your first one!</p>
          <Link
            href="/builder"
            className="inline-block bg-cyan-500 text-white px-6 py-3 rounded-lg font-bold hover:bg-cyan-600 transition"
          >
            Start Building
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {builds.map(build => (
            <div
              key={build.id}
              className="bg-slate-800/50 border border-slate-700 rounded-xl p-6 hover:border-slate-600 transition"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-2xl">{getAppTypeIcon(build.app_type)}</span>
                    <div>
                      <h3 className="text-white font-bold text-lg">{build.title}</h3>
                      <p className="text-slate-400 text-sm">{build.description}</p>
                    </div>
                  </div>
                </div>
                <div className={`px-3 py-1 rounded-full text-sm font-semibold border ${getStatusColor(build.status)}`}>
                  {getStatusLabel(build.status)}
                </div>
              </div>

              {/* Progress Bar */}
              {build.status !== 'completed' && build.status !== 'failed' && (
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-slate-400 text-sm">
                      Phase {build.current_phase}/{build.total_phases}
                    </p>
                    <p className="text-slate-400 text-sm">{build.progress_percentage}%</p>
                  </div>
                  <div className="w-full bg-slate-700 rounded-full h-2">
                    <div
                      className="bg-gradient-to-r from-cyan-500 to-blue-600 h-2 rounded-full transition-all"
                      style={{ width: `${build.progress_percentage}%` }}
                    ></div>
                  </div>
                </div>
              )}

              {/* Metadata */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 text-sm">
                <div>
                  <p className="text-slate-500">Type</p>
                  <p className="text-white capitalize">{build.app_type}</p>
                </div>
                <div>
                  <p className="text-slate-500">Complexity</p>
                  <p className="text-white capitalize">{build.complexity}</p>
                </div>
                <div>
                  <p className="text-slate-500">Credits Used</p>
                  <p className="text-white">{build.credits_used}</p>
                </div>
                <div>
                  <p className="text-slate-500">Created</p>
                  <p className="text-white">
                    {new Date(build.created_at).toLocaleDateString()}
                  </p>
                </div>
              </div>

              {/* Code Size */}
              {build.code_size_bytes && (
                <div className="text-sm text-slate-400 mb-4">
                  📦 {(build.code_size_bytes / 1024 / 1024).toFixed(2)} MB
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-3">
                {build.status === 'completed' && build.download_url && (
                  <>
                    <button
                      onClick={() => handleDownload(build.id)}
                      className="flex-1 bg-cyan-500 text-white px-4 py-2 rounded-lg font-semibold hover:bg-cyan-600 transition"
                    >
                      ⬇️ Download Code
                    </button>
                    {build.git_url && (
                      <a
                        href={build.git_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 bg-slate-700 text-white px-4 py-2 rounded-lg font-semibold hover:bg-slate-600 transition text-center"
                      >
                        🔗 View on GitHub
                      </a>
                    )}
                  </>
                )}
                <Link
                  href={`/dashboard/builds/${build.id}`}
                  className="flex-1 bg-slate-700 text-white px-4 py-2 rounded-lg font-semibold hover:bg-slate-600 transition text-center"
                >
                  📋 Details
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
