/**
 * Universal Loading Spinner
 * 
 * Simple, consistent loading indicator used throughout the portal.
 */

function LoadingSpinner({ size = 'md', message = '' }) {
  const sizeClasses = {
    sm: 'w-5 h-5 border-2',
    md: 'w-8 h-8 border-[3px]',
    lg: 'w-12 h-12 border-4',
  };

  return (
    <div className="flex flex-col items-center justify-center gap-3">
      <div
        className={`${sizeClasses[size]} border-gray-300 dark:border-gray-600 border-t-primary-600 rounded-full animate-spin`}
        role="status"
        aria-label="Loading"
      ></div>
      {message && (
        <p className="text-sm text-gray-600 dark:text-gray-400">{message}</p>
      )}
    </div>
  );
}

export default LoadingSpinner;
