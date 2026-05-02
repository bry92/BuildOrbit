'use client';



export default function Admin() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 to-slate-900 pt-20">
      <div className="max-w-7xl mx-auto px-6 py-8">
        <h1 className="text-4xl font-bold text-white mb-8">Admin Dashboard</h1>

        {/* Stats */}
        <div className="grid md:grid-cols-4 gap-6 mb-8">
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Total Users</p>
                <p className="text-3xl font-bold text-white">1,234</p>
              </div>
              <span className="text-3xl">👥</span>
            </div>
          </div>

          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Total Builds</p>
                <p className="text-3xl font-bold text-white">5,678</p>
              </div>
              <span className="text-3xl">📊</span>
            </div>
          </div>

          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Revenue (30d)</p>
                <p className="text-3xl font-bold text-white">$45,230</p>
              </div>
              <span className="text-3xl">💵</span>
            </div>
          </div>

          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Growth (30d)</p>
                <p className="text-3xl font-bold text-white">+23%</p>
              </div>
              <span className="text-3xl">📈</span>
            </div>
          </div>
        </div>

        {/* Analytics */}
        <div className="grid md:grid-cols-2 gap-8">
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
            <h2 className="text-xl font-bold text-white mb-4">Recent Signups</h2>
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-slate-700">
                  <div>
                    <p className="text-white font-semibold">User {i}</p>
                    <p className="text-slate-400 text-sm">user{i}@example.com</p>
                  </div>
                  <span className="text-slate-400 text-sm">2 hours ago</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
            <h2 className="text-xl font-bold text-white mb-4">Top Referrers</h2>
            <div className="space-y-4">
              {[
                { name: 'Alice Johnson', referrals: 12, revenue: '$2,400' },
                { name: 'Bob Smith', referrals: 8, revenue: '$1,600' },
                { name: 'Carol White', referrals: 5, revenue: '$1,000' },
              ].map((referrer, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-slate-700">
                  <div>
                    <p className="text-white font-semibold">{referrer.name}</p>
                    <p className="text-slate-400 text-sm">{referrer.referrals} referrals</p>
                  </div>
                  <span className="text-cyan-400 font-semibold">{referrer.revenue}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
