import { XCircle } from 'lucide-react';

function ErrorBanner({ message, onDismiss }) {
  if (!message) return null;

  return (
    <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 mb-4">
      <div className="flex items-start">
        <XCircle className="w-5 h-5 text-red-600 dark:text-red-400 mt-0.5" />
        <div className="ml-3 flex-1">
          <p className="text-sm text-red-800 dark:text-red-300">{message}</p>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

export default ErrorBanner;
