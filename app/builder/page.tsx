'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function BuilderPage() {
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    app_type: 'web',
    complexity: 'moderate',
    template: 'landing-page',
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [buildId, setBuildId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch('/api/v1/builds', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message || 'Failed to create build');
      }

      const data = await response.json();
      setBuildId(data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (buildId) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-950 to-slate-900 pt-20 px-6">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-8">
            <div className="text-6xl mb-4">✨</div>
            <h1 className="text-4xl font-bold text-white mb-2">Build Started!</h1>
            <p className="text-xl text-slate-400">Your app is being generated...</p>
          </div>

          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-8 mb-8">
            <div className="space-y-4">
              <div>
                <p className="text-slate-400 text-sm">Build ID</p>
                <p className="text-white font-mono text-sm break-all">{buildId}</p>
              </div>
              <div>
                <p className="text-slate-400 text-sm">Status</p>
                <div className="flex items-center gap-2 mt-2">
                  <div className="w-3 h-3 bg-cyan-400 rounded-full animate-pulse"></div>
                  <p className="text-white">Processing...</p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex gap-4 justify-center">
            <Link
              href="/dashboard"
              className="bg-cyan-500 text-white px-8 py-3 rounded-lg font-semibold hover:bg-cyan-600 transition"
            >
              View Dashboard
            </Link>
            <button
              onClick={() => setBuildId(null)}
              className="bg-slate-700 text-white px-8 py-3 rounded-lg font-semibold hover:bg-slate-600 transition"
            >
              Create Another
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 to-slate-900 pt-20 px-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-5xl font-bold text-white mb-4">Build Your App</h1>
          <p className="text-xl text-slate-400">
            Describe your idea. BuildOrbit generates production-ready code in minutes.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="bg-slate-800/50 border border-slate-700 rounded-xl p-8 mb-8">
          {error && (
            <div className="bg-red-500/10 border border-red-500/50 text-red-400 px-4 py-3 rounded-lg mb-6">
              {error}
            </div>
          )}

          {/* Title */}
          <div className="mb-6">
            <label htmlFor="title" className="block text-white font-semibold mb-2">
              Project Title
            </label>
            <input
              type="text"
              id="title"
              name="title"
              value={formData.title}
              onChange={handleInputChange}
              placeholder="e.g., E-commerce Landing Page"
              required
              className="w-full bg-slate-700/50 border border-slate-600 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
            />
          </div>

          {/* Description */}
          <div className="mb-6">
            <label htmlFor="description" className="block text-white font-semibold mb-2">
              Project Description
            </label>
            <textarea
              id="description"
              name="description"
              value={formData.description}
              onChange={handleInputChange}
              placeholder="Describe your app idea, features, design preferences, and any specific requirements..."
              required
              rows={6}
              className="w-full bg-slate-700/50 border border-slate-600 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 resize-none"
            />
          </div>

          {/* App Type */}
          <div className="grid grid-cols-2 gap-6 mb-6">
            <div>
              <label htmlFor="app_type" className="block text-white font-semibold mb-2">
                App Type
              </label>
              <select
                id="app_type"
                name="app_type"
                value={formData.app_type}
                onChange={handleInputChange}
                className="w-full bg-slate-700/50 border border-slate-600 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
              >
                <option value="web">Web Application</option>
                <option value="mobile">Mobile App</option>
                <option value="fullstack">Full-Stack</option>
              </select>
            </div>

            {/* Complexity */}
            <div>
              <label htmlFor="complexity" className="block text-white font-semibold mb-2">
                Complexity
              </label>
              <select
                id="complexity"
                name="complexity"
                value={formData.complexity}
                onChange={handleInputChange}
                className="w-full bg-slate-700/50 border border-slate-600 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
              >
                <option value="simple">Simple (1 credit)</option>
                <option value="moderate">Moderate (1 credit)</option>
                <option value="complex">Complex (2 credits)</option>
              </select>
            </div>
          </div>

          {/* Template */}
          <div className="mb-8">
            <label htmlFor="template" className="block text-white font-semibold mb-2">
              Template (Optional)
            </label>
            <select
              id="template"
              name="template"
              value={formData.template}
              onChange={handleInputChange}
              className="w-full bg-slate-700/50 border border-slate-600 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
            >
              <option value="">Auto-select best template</option>
              <option value="landing-page">Landing Page</option>
              <option value="saas">SaaS Dashboard</option>
              <option value="ecommerce">E-commerce Store</option>
              <option value="blog">Blog Platform</option>
              <option value="portfolio">Portfolio</option>
              <option value="mobile-app">Mobile App</option>
            </select>
          </div>

          {/* Credits Info */}
          <div className="bg-slate-700/30 border border-slate-600 rounded-lg p-4 mb-8">
            <p className="text-slate-300 text-sm">
              💡 <strong>This build will cost 1 credit.</strong> You have 10 credits available. Upgrade to get unlimited builds.
            </p>
          </div>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white px-8 py-4 rounded-lg font-bold text-lg hover:shadow-lg hover:shadow-cyan-500/50 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Creating Build...' : 'Start Building'}
          </button>
        </form>

        {/* Info Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
            <div className="text-3xl mb-3">⚡</div>
            <h3 className="text-white font-bold mb-2">Fast</h3>
            <p className="text-slate-400 text-sm">
              Get production-ready code in minutes, not days.
            </p>
          </div>

          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
            <div className="text-3xl mb-3">🎯</div>
            <h3 className="text-white font-bold mb-2">Accurate</h3>
            <p className="text-slate-400 text-sm">
              AI understands your requirements and builds exactly what you need.
            </p>
          </div>

          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
            <div className="text-3xl mb-3">📦</div>
            <h3 className="text-white font-bold mb-2">Complete</h3>
            <p className="text-slate-400 text-sm">
              Full source code, documentation, and deployment ready.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
