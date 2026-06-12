import { XCircle, X } from 'lucide-react';

function ErrorBanner({ message, onClose }) {
  if (!message) return null;

  return (
    <div className="bg-gradient-to-r from-red-50 to-rose-50 dark:from-red-900/20 dark:to-rose-900/20 border border-red-200 dark:border-red-800/50 rounded-lg p-2 shadow-sm">
      <div className="flex items-start gap-2">
        <div className="p-0.5 bg-red-100 dark:bg-red-900/30 rounded">
          <XCircle className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-red-800 dark:text-red-300">{message}</p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Dismiss message"
            className="p-0.5 rounded text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}

export default ErrorBanner;
