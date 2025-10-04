import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Link, useLocation } from 'react-router-dom';

interface LayoutProps {
  children: React.ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const navigation = [
    { name: 'Dashboard', href: '/', icon: HomeIcon },
    { name: 'Activity', href: '/activity', icon: ActivityIcon },
    { name: 'Repositories', href: '/repositories', icon: RepoIcon },
    { name: 'Tasks', href: '/tasks', icon: TaskIcon },
    { name: 'AI Tools', href: '/ai-tools', icon: AiIcon },
    { name: 'Settings', href: '/settings', icon: SettingsIcon },
  ];

  const isActive = (path: string) => location.pathname === path;

  return (
    <div className="h-screen flex overflow-hidden bg-gray-100">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-gray-600 bg-opacity-75 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div className={`${
        sidebarOpen ? 'translate-x-0' : '-translate-x-full'
      } fixed inset-y-0 left-0 z-50 w-64 bg-gray-900 transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:inset-0`}>
        <div className="flex h-16 items-center justify-between px-4">
          <h2 className="text-xl font-semibold text-white">GitFix</h2>
          <button
            className="lg:hidden text-gray-400 hover:text-white"
            onClick={() => setSidebarOpen(false)}
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <nav className="mt-5 flex-1 space-y-1 px-2">
          {navigation.map((item) => (
            <Link
              key={item.name}
              to={item.href}
              className={`${
                isActive(item.href)
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-300 hover:bg-gray-700 hover:text-white'
              } group flex items-center px-2 py-2 text-sm font-medium rounded-md`}
            >
              <item.icon className="mr-3 h-5 w-5" />
              {item.name}
            </Link>
          ))}
        </nav>
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col">
        {/* Header */}
        <header className="bg-white shadow-sm">
          <div className="flex h-16 items-center justify-between px-4 sm:px-6 lg:px-8">
            <button
              className="lg:hidden text-gray-500 hover:text-gray-900"
              onClick={() => setSidebarOpen(true)}
            >
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <div className="flex items-center space-x-4 ml-auto">
              <span className="text-sm text-gray-700">{user?.displayName || user?.username}</span>
              {user?.avatarUrl && (
                <img
                  className="h-8 w-8 rounded-full"
                  src={user.avatarUrl}
                  alt={user.displayName || user.username}
                />
              )}
              <button
                onClick={logout}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Logout
              </button>
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
};

// Icon components
const HomeIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
  </svg>
);

const ActivityIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const QueueIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
  </svg>
);

const ChartIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
  </svg>
);

const RepoIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
  </svg>
);

const TaskIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
  </svg>
);

const AiIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
  </svg>
);

const SettingsIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

export default Layout;