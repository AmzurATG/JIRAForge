import { useAuth } from '../../contexts/AuthContext';
import { LogOut, Moon, Sun, User, Bell } from 'lucide-react';
import { useState } from 'react';

function Header() {
  const { user, logout } = useAuth();
  const [darkMode, setDarkMode] = useState(
    document.documentElement.classList.contains('dark')
  );

  const toggleDarkMode = () => {
    setDarkMode(!darkMode);
    document.documentElement.classList.toggle('dark');
    localStorage.setItem('darkMode', !darkMode);
  };

  return (
    <header className="h-12 bg-white/90 dark:bg-gray-800/90 backdrop-blur-lg border-b border-gray-200 dark:border-gray-700 fixed top-0 right-0 left-0 z-40 shadow-sm">
      <div className="flex items-center justify-end h-full px-4 gap-2">
        {/* Notifications (placeholder) */}
        <button className="relative p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors">
          <Bell className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-red-500 rounded-full ring-1 ring-white dark:ring-gray-800" />
        </button>
        
        {/* Dark mode toggle */}
        <button
          onClick={toggleDarkMode}
          className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
        >
          {darkMode ? (
            <Sun className="w-4 h-4 text-amber-500" />
          ) : (
            <Moon className="w-4 h-4 text-gray-500" />
          )}
        </button>
        
        {/* Divider */}
        <div className="w-px h-6 bg-gray-200 dark:bg-gray-700" />
        
        {/* User profile */}
        <div className="flex items-center gap-2 pl-1">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center shadow-sm">
            <User className="w-4 h-4 text-white" />
          </div>
          <div className="text-right">
            <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">
              {user?.displayName || 'User'}
            </p>
            <p className="text-[10px] text-gray-500 dark:text-gray-400">
              {user?.role || 'admin'}
            </p>
          </div>
        </div>
        
        {/* Logout button */}
        <button
          onClick={logout}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 
          bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 
          rounded-lg transition-all duration-200 hover:shadow-sm"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Logout</span>
        </button>
      </div>
    </header>
  );
}

export default Header;
