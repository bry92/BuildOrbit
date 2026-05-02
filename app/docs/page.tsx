'use client';

import Link from 'next/link';

export default function Docs() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 to-slate-900 pt-20">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <h1 className="text-4xl font-bold text-white mb-8">Documentation</h1>

        <div className="grid md:grid-cols-3 gap-8">
          {[
            {
              title: 'Getting Started',
              desc: 'Learn how to create your first app with BuildOrbit',
              link: '#',
            },
            {
              title: 'API Reference',
              desc: 'Complete API documentation for BuildOrbit',
              link: '#',
            },
            {
              title: 'Deployment Guide',
              desc: 'Deploy your apps to production',
              link: '#',
            },
            {
              title: 'Templates',
              desc: 'Browse pre-built app templates',
              link: '#',
            },
            {
              title: 'Best Practices',
              desc: 'Tips and tricks for building great apps',
              link: '#',
            },
            {
              title: 'FAQ',
              desc: 'Frequently asked questions',
              link: '#',
            },
          ].map((doc, idx) => (
            <Link
              key={idx}
              href={doc.link}
              className="bg-slate-800/50 border border-slate-700 rounded-xl p-6 hover:border-cyan-500/50 transition"
            >
              <h3 className="text-xl font-bold text-white mb-2">{doc.title}</h3>
              <p className="text-slate-400">{doc.desc}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
