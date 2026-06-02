import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Clock,
  FileText,
  Settings,
  Activity,
  ChevronLeft,
  ChevronRight,
  ListChecks,
  Building2
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

function Sidebar({ collapsed, onToggle }) {
  const { user } = useAuth();
  const isSuperadmin = user?.role === 'superadmin';

  const menuItems = [
    { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { path: '/employees', label: 'Employees', icon: Users },
    { path: '/time-logs', label: 'Time Logs', icon: Clock },
    { path: '/reports', label: 'Reports', icon: FileText },
    { path: '/lobs', label: 'Line of Businesses', icon: Building2, superadminOnly: true },
    { path: '/app-classifications', label: 'App Classifications', icon: ListChecks },
    { path: '/settings', label: 'Settings', icon: Settings },
  ].filter((item) => !item.superadminOnly || isSuperadmin);

  return (
    <aside className={`${
      collapsed ? 'w-16' : 'w-56'
    } bg-gradient-to-b from-gray-900 via-gray-900 to-gray-800 h-screen fixed left-0 top-0 shadow-xl transition-all duration-300 z-50`}>
      {/* Logo & Toggle */}
      <div className={`h-12 px-3 border-b border-gray-700/50 flex items-center ${collapsed ? 'justify-center' : 'justify-between'}`}>
        {!collapsed && (
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-gradient-to-br from-primary-500 to-primary-700 rounded-lg shadow-md">
              <Activity className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-white">
                Time Tracker
              </h1>
              <p className="text-[10px] text-gray-400">Portal</p>
            </div>
          </div>
        )}
        {!collapsed && (
          <button
            onClick={onToggle}
            className="p-1.5 rounded-lg hover:bg-gray-800 transition-colors text-gray-400 hover:text-white flex-shrink-0"
            title="Collapse sidebar"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
        {collapsed && (
          <button
            onClick={onToggle}
            className="p-1.5 rounded-lg hover:bg-gray-800 transition-colors text-gray-400 hover:text-white"
            title="Expand sidebar"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </div>
      
      {/* Navigation */}
      <nav className="px-2 py-3">
        {!collapsed && (
          <p className="px-2 mb-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
            Menu
          </p>
        )}
        {menuItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              `group flex items-center gap-2 px-2 py-2 rounded-lg mb-1 transition-all duration-200 ${
                isActive
                  ? 'bg-gradient-to-r from-primary-600 to-primary-700 text-white shadow-md'
                  : 'text-gray-400 hover:bg-gray-800/60 hover:text-white'
              } ${collapsed ? 'justify-center' : ''}`
            }
            title={collapsed ? item.label : ''}
          >
            {({ isActive }) => (
              <>
                <item.icon className="w-4 h-4 flex-shrink-0" />
                {!collapsed && (
                  <span className="text-sm font-medium">{item.label}</span>
                )}
                {isActive && !collapsed && (
                  <div className="ml-auto w-1 h-1 rounded-full bg-white/80" />
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      
      {/* Footer */}
      {!collapsed && (
        <div className="absolute bottom-0 left-0 right-0 p-3 border-t border-gray-700/50">
          <div className="px-2 py-1.5 bg-gray-800/50 rounded-lg">
            <p className="text-[10px] text-gray-500">Version 1.0.0</p>
            <p className="text-[10px] text-gray-600">© 2026 BRD Tracker</p>
          </div>
        </div>
      )}
    </aside>
  );
}

export default Sidebar;
