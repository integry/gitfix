import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { getQueueStats } from '../api/gitfixApi';

interface LayoutProps {
  children: React.ReactNode;
}

interface NavItem {
  name: string;
  href: string;
  icon: React.FC<{ className?: string }>;
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();
  const [activeTaskCount, setActiveTaskCount] = useState<number>(0);

  const navigation: NavItem[] = [
    { name: 'Dashboard', href: '/', icon: HomeIcon },
    { name: 'Repositories', href: '/repositories', icon: RepoIcon },
    { name: 'Tasks', href: '/tasks', icon: TaskIcon },
    { name: 'AI Tools', href: '/ai-tools', icon: AiIcon },
    { name: 'Settings', href: '/settings', icon: SettingsIcon },
  ];

  const isActive = (path: string): boolean => location.pathname === path;

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const data = await getQueueStats();
        setActiveTaskCount(data.active || 0);
      } catch (err) {
        console.error('Error fetching queue stats for layout:', err);
        setActiveTaskCount(0);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex min-h-screen bg-brand-dark">
      {/* Sidebar */}
      <aside className="w-60 bg-brand-component py-6 border-r border-brand-border">
        <div className="px-4 mb-8 flex items-center">
          <img src="/logo-and-name.png" alt="GitFix Logo" className="h-10 w-auto" />
        </div>
        <nav className="flex flex-col gap-1">
          {navigation.map((item) => (
            <Link
              key={item.name}
              to={item.href}
              className={`flex items-center px-4 py-3 text-sm font-medium transition-all duration-200 ${
                isActive(item.href)
                  ? 'bg-brand-accent/20 text-brand-accent border-r-2 border-brand-accent'
                  : 'text-brand-text-dim hover:bg-brand-border hover:text-brand-text-light'
              }`}
            >
              <item.icon className="w-5 h-5 mr-3" />
              {item.name}
              {item.name === 'Tasks' && activeTaskCount > 0 && (
                <span className="ml-auto inline-flex items-center justify-center h-5 w-5 rounded-full bg-brand-accent text-xs font-semibold text-white">
                  {activeTaskCount}
                </span>
              )}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col">
        <main className="flex-1 p-8 overflow-y-auto bg-brand-dark">
          {children}
        </main>
      </div>
    </div>
  );
};

// Icon components
interface IconProps {
  className?: string;
}

const HomeIcon: React.FC<IconProps> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
  </svg>
);

const RepoIcon: React.FC<IconProps> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
  </svg>
);

const TaskIcon: React.FC<IconProps> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
  </svg>
);

const AiIcon: React.FC<IconProps> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
  </svg>
);

const SettingsIcon: React.FC<IconProps> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

export default Layout;
