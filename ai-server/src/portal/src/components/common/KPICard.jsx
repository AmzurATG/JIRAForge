function KPICard({ title, value, subtitle, icon: Icon, trend, variant = 'default' }) {
  const variants = {
    default: 'from-primary-500 to-primary-600',
    success: 'from-emerald-500 to-green-600',
    warning: 'from-amber-500 to-orange-600',
    danger: 'from-red-500 to-rose-600',
    info: 'from-blue-500 to-indigo-600',
  };
  
  const iconBgVariants = {
    default: 'bg-primary-100 dark:bg-primary-900/30 text-primary-600 dark:text-primary-400',
    success: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400',
    warning: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
    danger: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
    info: 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
  };

  return (
    <div className="group relative overflow-hidden bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700/50 p-3 transition-all duration-200 hover:shadow-md hover:-translate-y-0.5">
      {/* Gradient accent line */}
      <div className={`absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r ${variants[variant]} opacity-80`} />
      
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-1">
            {title}
          </p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 tracking-tight truncate">
            {value}
          </p>
          {subtitle && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 flex items-center gap-1 truncate">
              {subtitle}
            </p>
          )}
        </div>
        {Icon && (
          <div className={`p-2 rounded-lg flex-shrink-0 ${iconBgVariants[variant]} transition-transform group-hover:scale-110`}>
            <Icon className="w-4 h-4" />
          </div>
        )}
      </div>
      
      {trend !== undefined && trend !== null && (
        <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700/50">
          <div className="flex items-center gap-1.5">
            <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${
              trend >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
            }`}>
              <svg className={`w-3 h-3 ${trend < 0 ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
              </svg>
              {Math.abs(trend)}%
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">vs last period</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default KPICard;
