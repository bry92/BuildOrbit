'use client';

export default function Blog() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 to-slate-900 pt-20">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <h1 className="text-4xl font-bold text-white mb-8">Blog</h1>

        <div className="grid md:grid-cols-2 gap-8">
          {[
            {
              title: 'Introducing BuildOrbit',
              excerpt: 'The future of app development is here. AI-powered, production-ready, and deployed in minutes.',
              date: 'April 23, 2026',
              author: 'BuildOrbit Team',
            },
            {
              title: 'How to Build a SaaS App in 10 Minutes',
              excerpt: 'Learn how to use BuildOrbit to create a complete SaaS application with authentication and payments.',
              date: 'April 20, 2026',
              author: 'Jane Doe',
            },
            {
              title: 'BuildOrbit vs Traditional Development',
              excerpt: 'Comparing BuildOrbit with traditional development approaches. Speed, cost, and quality analysis.',
              date: 'April 15, 2026',
              author: 'John Smith',
            },
            {
              title: 'Scaling Your BuildOrbit Apps',
              excerpt: 'Best practices for scaling applications built with BuildOrbit to handle millions of users.',
              date: 'April 10, 2026',
              author: 'BuildOrbit Team',
            },
          ].map((post, idx) => (
            <article
              key={idx}
              className="bg-slate-800/50 border border-slate-700 rounded-xl p-6 hover:border-cyan-500/50 transition cursor-pointer"
            >
              <h3 className="text-2xl font-bold text-white mb-2">{post.title}</h3>
              <p className="text-slate-400 mb-4">{post.excerpt}</p>
              <div className="flex items-center justify-between text-sm text-slate-500">
                <span>{post.date}</span>
                <span>By {post.author}</span>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
