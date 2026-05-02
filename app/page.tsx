'use client';

export default function Home() {
  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif', margin: 0, padding: 0, backgroundColor: '#0f172a', color: '#e2e8f0', overflow: 'hidden' }}>
      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-20px); }
        }
        
        @keyframes cloudDrift {
          0% { transform: translateX(-100%); opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { transform: translateX(100vw); opacity: 0; }
        }
        
        @keyframes cloudDrift2 {
          0% { transform: translateX(-100%); opacity: 0; }
          10% { opacity: 0.7; }
          90% { opacity: 0.7; }
          100% { transform: translateX(100vw); opacity: 0; }
        }
        
        @keyframes glow {
          0%, 100% { box-shadow: 0 0 20px rgba(34, 211, 238, 0.3); }
          50% { box-shadow: 0 0 40px rgba(34, 211, 238, 0.6); }
        }
        
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }
        
        @keyframes slideInLeft {
          from { opacity: 0; transform: translateX(-30px); }
          to { opacity: 1; transform: translateX(0); }
        }
        
        @keyframes slideInRight {
          from { opacity: 0; transform: translateX(30px); }
          to { opacity: 1; transform: translateX(0); }
        }
        
        @keyframes pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.05); }
        }
        
        .cloud {
          position: absolute;
          background: radial-gradient(ellipse at 30% 30%, rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.3));
          border-radius: 100px;
          filter: blur(40px);
        }
        
        .cloud1 { width: 200px; height: 60px; top: 10%; animation: cloudDrift 20s linear infinite; }
        .cloud2 { width: 150px; height: 50px; top: 20%; animation: cloudDrift 25s linear infinite 5s; }
        .cloud3 { width: 180px; height: 55px; top: 30%; animation: cloudDrift2 30s linear infinite 10s; }
        .cloud4 { width: 160px; height: 50px; top: 15%; animation: cloudDrift 22s linear infinite 8s; }
        
        .hero-content { animation: slideUp 0.8s ease-out; }
        .feature-card { animation: slideUp 0.8s ease-out; transition: all 0.3s ease; }
        .feature-card:hover { transform: translateY(-10px); box-shadow: 0 20px 40px rgba(34, 211, 238, 0.2); }
        
        .pricing-card { animation: slideUp 0.8s ease-out; transition: all 0.3s ease; }
        .pricing-card:hover { transform: translateY(-15px); }
        
        .btn { transition: all 0.3s ease; cursor: pointer; }
        .btn:hover { transform: scale(1.05); }
        .btn:active { transform: scale(0.95); }
        
        .gradient-text { background: linear-gradient(to right, #22d3ee, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
        
        .glow-box { animation: glow 3s ease-in-out infinite; }
        
        .float { animation: float 3s ease-in-out infinite; }
      `}</style>

      {/* Animated Background Clouds */}
      <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        <div className="cloud cloud1" style={{ left: '5%' }}></div>
        <div className="cloud cloud2" style={{ left: '10%' }}></div>
        <div className="cloud cloud3" style={{ left: '15%' }}></div>
        <div className="cloud cloud4" style={{ left: '20%' }}></div>
      </div>

      {/* Content Wrapper */}
      <div style={{ position: 'relative', zIndex: 1 }}>
        {/* Navigation */}
        <nav style={{ position: 'fixed', top: 0, width: '100%', zIndex: 50, backgroundColor: 'rgba(15, 23, 42, 0.9)', backdropFilter: 'blur(10px)', borderBottom: '1px solid rgba(34, 211, 238, 0.2)', padding: '16px 40px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxSizing: 'border-box' }}>
          <div style={{ fontSize: '24px', fontWeight: 'bold' }} className="gradient-text">🚀 BuildOrbit</div>
          <div style={{ display: 'flex', gap: '32px', alignItems: 'center' }}>
            <a href="/docs" style={{ textDecoration: 'none', color: '#cbd5e1', cursor: 'pointer', fontSize: '14px', transition: 'color 0.3s ease' }} onMouseEnter={(e) => e.target.style.color = '#22d3ee'} onMouseLeave={(e) => e.target.style.color = '#cbd5e1'}>Docs</a>
            <a href="/pricing" style={{ textDecoration: 'none', color: '#cbd5e1', cursor: 'pointer', fontSize: '14px', transition: 'color 0.3s ease' }} onMouseEnter={(e) => e.target.style.color = '#22d3ee'} onMouseLeave={(e) => e.target.style.color = '#cbd5e1'}>Pricing</a>
            <a href="/auth/login" style={{ textDecoration: 'none', color: '#cbd5e1', cursor: 'pointer', fontSize: '14px', transition: 'color 0.3s ease' }} onMouseEnter={(e) => e.target.style.color = '#22d3ee'} onMouseLeave={(e) => e.target.style.color = '#cbd5e1'}>Sign In</a>
            <a href="/auth/signup" className="btn" style={{ padding: '10px 20px', background: 'linear-gradient(to right, #06b6d4, #2563eb)', color: 'white', borderRadius: '8px', textDecoration: 'none', fontSize: '14px', fontWeight: '600', cursor: 'pointer', boxShadow: '0 0 20px rgba(34, 211, 238, 0.3)' }}>Get Started</a>
          </div>
        </nav>

        {/* Hero Section */}
        <section style={{ paddingTop: '128px', paddingBottom: '80px', paddingLeft: '24px', paddingRight: '24px', textAlign: 'center', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="hero-content" style={{ maxWidth: '1280px', margin: '0 auto' }}>
            <div style={{ display: 'inline-block', marginBottom: '24px', padding: '8px 16px', backgroundColor: 'rgba(34, 211, 238, 0.1)', border: '1px solid rgba(34, 211, 238, 0.3)', borderRadius: '9999px', animation: 'slideUp 0.8s ease-out 0.1s both' }}>
              <span style={{ color: '#22d3ee', fontSize: '14px', fontWeight: '600' }}>✨ AI-Powered App Builder</span>
            </div>

            <h1 style={{ fontSize: '64px', fontWeight: 'bold', color: 'white', marginBottom: '24px', lineHeight: '1.2', animation: 'slideUp 0.8s ease-out 0.2s both' }}>
              Build Production-Ready Apps<br />
              <span className="gradient-text">in Minutes, Not Months</span>
            </h1>

            <p style={{ fontSize: '18px', color: '#cbd5e1', marginBottom: '32px', maxWidth: '768px', margin: '0 auto 32px', animation: 'slideUp 0.8s ease-out 0.3s both' }}>
              BuildOrbit uses AI to generate complete, production-ready applications. From landing pages to full-stack platforms, describe your idea and watch it come to life.
            </p>

            <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', marginBottom: '48px', flexWrap: 'wrap', animation: 'slideUp 0.8s ease-out 0.4s both' }}>
              <a href="/builder" className="btn" style={{ padding: '16px 32px', background: 'linear-gradient(to right, #06b6d4, #2563eb)', color: 'white', borderRadius: '8px', textDecoration: 'none', fontSize: '16px', fontWeight: '600', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '8px', boxShadow: '0 0 30px rgba(34, 211, 238, 0.4)' }}>Start Building Free →</a>
              <a href="/docs" className="btn" style={{ padding: '16px 32px', border: '2px solid rgba(34, 211, 238, 0.5)', color: 'white', borderRadius: '8px', textDecoration: 'none', fontSize: '16px', fontWeight: '600', cursor: 'pointer', display: 'inline-block', background: 'rgba(34, 211, 238, 0.05)', backdropFilter: 'blur(10px)' }}>View Documentation</a>
            </div>

            {/* Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '32px', maxWidth: '512px', margin: '0 auto', animation: 'slideUp 0.8s ease-out 0.5s both' }}>
              <div className="float">
                <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#22d3ee', marginBottom: '8px' }}>10+</div>
                <div style={{ color: '#94a3b8' }}>App Types</div>
              </div>
              <div className="float" style={{ animationDelay: '0.2s' }}>
                <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#22d3ee', marginBottom: '8px' }}>6</div>
                <div style={{ color: '#94a3b8' }}>Phase Pipeline</div>
              </div>
              <div className="float" style={{ animationDelay: '0.4s' }}>
                <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#22d3ee', marginBottom: '8px' }}>100%</div>
                <div style={{ color: '#94a3b8' }}>Production Ready</div>
              </div>
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section style={{ paddingTop: '80px', paddingBottom: '80px', paddingLeft: '24px', paddingRight: '24px', background: 'linear-gradient(to bottom, transparent, rgba(34, 211, 238, 0.05))' }}>
          <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
            <h2 style={{ fontSize: '36px', fontWeight: 'bold', color: 'white', textAlign: 'center', marginBottom: '16px', animation: 'slideUp 0.8s ease-out' }}>Why BuildOrbit?</h2>
            <p style={{ color: '#cbd5e1', textAlign: 'center', marginBottom: '64px', maxWidth: '768px', margin: '0 auto 64px', animation: 'slideUp 0.8s ease-out 0.1s both' }}>Everything you need to build and deploy production-ready applications</p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '32px' }}>
              {[
                { icon: '⚡', title: 'Lightning Fast', desc: 'Generate complete apps in minutes using AI. No more waiting days for development.' },
                { icon: '💻', title: 'Full Source Code', desc: 'Get complete, production-ready source code. Customize, deploy, and own your application.' },
                { icon: '🚀', title: 'Deploy Anywhere', desc: 'Docker, Kubernetes, Vercel, AWS — deploy to any platform with included configurations.' },
                { icon: '👥', title: 'All App Types', desc: 'Web apps, mobile apps, full-stack platforms, landing pages, and more.' },
                { icon: '📈', title: 'Scalable Architecture', desc: 'Built for scale with microservices, caching, load balancing, and real-time features.' },
                { icon: '🛡️', title: 'Enterprise Security', desc: 'GDPR, HIPAA, SOC 2, PCI DSS compliance built-in. Security by default.' },
              ].map((feature, idx) => (
                <div key={idx} className="feature-card" style={{ backgroundColor: 'rgba(30, 41, 59, 0.5)', border: '1px solid rgba(34, 211, 238, 0.2)', borderRadius: '12px', padding: '32px', backdropFilter: 'blur(10px)', animation: `slideUp 0.8s ease-out ${0.1 + idx * 0.1}s both` }}>
                  <div style={{ fontSize: '32px', marginBottom: '16px' }}>{feature.icon}</div>
                  <h3 style={{ fontSize: '18px', fontWeight: '600', color: 'white', marginBottom: '8px' }}>{feature.title}</h3>
                  <p style={{ color: '#cbd5e1', fontSize: '14px' }}>{feature.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pipeline Section */}
        <section style={{ paddingTop: '80px', paddingBottom: '80px', paddingLeft: '24px', paddingRight: '24px' }}>
          <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
            <h2 style={{ fontSize: '36px', fontWeight: 'bold', color: 'white', textAlign: 'center', marginBottom: '64px', animation: 'slideUp 0.8s ease-out' }}>The BuildOrbit Pipeline</h2>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px' }}>
              {[
                { num: '1', title: 'Intent Gate', desc: 'Analyze your idea' },
                { num: '2', title: 'Plan', desc: 'Design architecture' },
                { num: '3', title: 'Scaffold', desc: 'Create structure' },
                { num: '4', title: 'Code', desc: 'Generate code' },
                { num: '5', title: 'Save', desc: 'Version control' },
                { num: '6', title: 'Verify', desc: 'Quality checks' },
              ].map((phase, idx) => (
                <div key={idx} className="feature-card" style={{ background: 'linear-gradient(135deg, rgba(34, 211, 238, 0.15), rgba(59, 130, 246, 0.15))', border: '1px solid rgba(34, 211, 238, 0.3)', borderRadius: '8px', padding: '24px', textAlign: 'center', backdropFilter: 'blur(10px)', animation: `slideUp 0.8s ease-out ${0.1 + idx * 0.05}s both` }}>
                  <div style={{ fontSize: '28px', fontWeight: 'bold', color: '#22d3ee', marginBottom: '8px' }}>{phase.num}</div>
                  <h3 style={{ color: 'white', fontWeight: '600', marginBottom: '4px' }}>{phase.title}</h3>
                  <p style={{ color: '#94a3b8', fontSize: '12px' }}>{phase.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing Section */}
        <section style={{ paddingTop: '80px', paddingBottom: '80px', paddingLeft: '24px', paddingRight: '24px', background: 'linear-gradient(to bottom, transparent, rgba(34, 211, 238, 0.05))' }}>
          <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
            <h2 style={{ fontSize: '36px', fontWeight: 'bold', color: 'white', textAlign: 'center', marginBottom: '16px', animation: 'slideUp 0.8s ease-out' }}>Simple Pricing</h2>
            <p style={{ color: '#cbd5e1', textAlign: 'center', marginBottom: '64px', maxWidth: '768px', margin: '0 auto 64px', animation: 'slideUp 0.8s ease-out 0.1s both' }}>Start free with 10 credits. Upgrade anytime or earn credits through referrals.</p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '32px' }}>
              {[
                { name: 'Free', price: '$0', features: ['10 credits', '1 build/month', 'Web templates'] },
                { name: 'Starter', price: '$29', period: '/month', features: ['10 builds/month', '5 downloads', 'Web + Mobile'], highlighted: true },
                { name: 'Pro', price: '$99', period: '/month', features: ['50 builds/month', '25 downloads', 'All app types', 'API access'] },
                { name: 'Enterprise', price: 'Custom', features: ['Unlimited builds', 'White-label', 'Dedicated support'] },
              ].map((plan, idx) => (
                <div key={idx} className="pricing-card" style={{ borderRadius: '12px', padding: '32px', backgroundColor: plan.highlighted ? 'rgba(34, 211, 238, 0.15)' : 'rgba(30, 41, 59, 0.5)', border: plan.highlighted ? '2px solid #22d3ee' : '1px solid rgba(34, 211, 238, 0.2)', transform: plan.highlighted ? 'scale(1.05)' : 'scale(1)', backdropFilter: 'blur(10px)', animation: `slideUp 0.8s ease-out ${0.1 + idx * 0.1}s both`, boxShadow: plan.highlighted ? '0 0 40px rgba(34, 211, 238, 0.3)' : 'none' }}>
                  <h3 style={{ fontSize: '20px', fontWeight: '600', color: 'white', marginBottom: '8px' }}>{plan.name}</h3>
                  <div style={{ marginBottom: '24px' }}>
                    <span style={{ fontSize: '32px', fontWeight: 'bold', color: '#22d3ee' }}>{plan.price}</span>
                    {plan.period && <span style={{ color: '#94a3b8' }}>{plan.period}</span>}
                  </div>
                  <ul style={{ listStyle: 'none', marginBottom: '32px', padding: 0 }}>
                    {plan.features.map((feature, i) => (
                      <li key={i} style={{ color: '#cbd5e1', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ color: '#22d3ee' }}>✓</span> {feature}
                      </li>
                    ))}
                  </ul>
                  <button className="btn" style={{ width: '100%', padding: '12px', borderRadius: '8px', fontWeight: '600', cursor: 'pointer', backgroundColor: plan.highlighted ? '#22d3ee' : 'transparent', color: plan.highlighted ? '#0f172a' : 'white', border: plan.highlighted ? 'none' : '1px solid rgba(34, 211, 238, 0.5)', transition: 'all 0.3s ease' }}>Get Started</button>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section style={{ paddingTop: '80px', paddingBottom: '80px', paddingLeft: '24px', paddingRight: '24px', background: 'linear-gradient(135deg, #06b6d4, #2563eb)', textAlign: 'center' }}>
          <h2 style={{ fontSize: '36px', fontWeight: 'bold', color: 'white', marginBottom: '16px', animation: 'slideUp 0.8s ease-out' }}>Ready to Build?</h2>
          <p style={{ fontSize: '18px', color: 'rgba(255, 255, 255, 0.9)', marginBottom: '32px', animation: 'slideUp 0.8s ease-out 0.1s both' }}>Start building your next app today with AI-powered development.</p>
          <a href="/auth/signup" className="btn" style={{ padding: '14px 32px', backgroundColor: 'white', color: '#06b6d4', borderRadius: '8px', textDecoration: 'none', fontSize: '16px', fontWeight: '600', cursor: 'pointer', display: 'inline-block', boxShadow: '0 10px 30px rgba(0, 0, 0, 0.3)', animation: 'slideUp 0.8s ease-out 0.2s both' }}>Get Started Free</a>
        </section>

        {/* Footer */}
        <footer style={{ padding: '40px', backgroundColor: '#0a0f1a', color: '#94a3b8', textAlign: 'center', fontSize: '14px', borderTop: '1px solid #1e293b' }}>
          <p>&copy; 2026 BuildOrbit. All rights reserved.</p>
        </footer>
      </div>
    </div>
  );
}
