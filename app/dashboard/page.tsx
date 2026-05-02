'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import BuildsPage from './builds';

export default function Dashboard() {
  const [stats, setStats] = useState({
    credits: 10,
    builds: 0,
    referrals: 0,
    trial_days_left: 3,
  });

  useEffect(() => {
    // Fetch user stats from API
    const fetchStats = async () => {
      try {
        const response = await fetch('/api/v1/user', {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`,
          },
        });
        if (response.ok) {
          const data = await response.json();
          setStats(data);
        }
      } catch (err) {
        console.error('Failed to fetch stats:', err);
      }
    };

    fetchStats();
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 to-slate-900 pt-20">
      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-4xl font-bold text-white">Dashboard</h1>
            <p className="text-slate-400 mt-2">Welcome back! Here's your BuildOrbit overview.</p>
          </div>
          <Link
            href="/builder"
            className="bg-gradient-to-r from-cyan-500 to-blue-600 text-white px-6 py-3 rounded-lg font-bold flex items-center gap-2 hover:shadow-lg hover:shadow-cyan-500/50 transition"
          >
            <span>➕</span> New Build
          </Link>
        </div>

        {/* Stats */}
        <div className="grid md:grid-cols-4 gap-6 mb-8">
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Credits</p>
                <p className="text-3xl font-bold text-white">{stats.credits}</p>
              </div>
              <span className="text-3xl">⚡</span>
            </div>
          </div>

          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Builds</p>
                <p className="text-3xl font-bold text-white">{stats.builds}</p>
              </div>
              <span className="text-3xl">📦</span>
            </div>
          </div>

          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Referrals</p>
                <p className="text-3xl font-bold text-white">{stats.referrals}</p>
              </div>
              <span className="text-3xl">👥</span>
            </div>
          </div>

          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Trial Days Left</p>
                <p className="text-3xl font-bold text-white">{stats.trial_days_left}</p>
              </div>
              <span className="text-3xl">⏱️</span>
            </div>
          </div>
        </div>

        {/* Builds Section */}
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-8">
          <BuildsPage />
        </div>
      </div>
    </div>
  );
}
