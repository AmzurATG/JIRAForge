import { CheckCircle2, X } from 'lucide-react';

function SuccessBanner({ message, onClose }) {
  if (!message) return null;

  return (
    <div className="bg-gradient-to-r from-emerald-50 to-green-50 dark:from-emerald-900/20 dark:to-green-900/20 border border-emerald-200 dark:border-emerald-800/50 rounded-lg p-2 shadow-sm">
      <div className="flex items-start gap-2">
        <div className="p-0.5 bg-emerald-100 dark:bg-emerald-900/30 rounded">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-emerald-800 dark:text-emerald-300">{message}</p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Dismiss message"
            className="p-0.5 rounded text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}

export default SuccessBanner;
