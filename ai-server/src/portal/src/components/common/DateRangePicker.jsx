/**
 * DateRangePicker Component
 * 
 * Date range picker with preset buttons and custom date inputs.
 */

import { useState } from 'react';
import { Calendar } from 'lucide-react';
import { formatDate } from '../../utils/formatters';

function DateRangePicker({ from, to, onChange }) {
  const [customFrom, setCustomFrom] = useState(from);
  const [customTo, setCustomTo] = useState(to);
  const [showCustom, setShowCustom] = useState(false);

  const handlePresetClick = (days) => {
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(toDate.getDate() - days);
    
    onChange({
      from: formatDate(fromDate),
      to: formatDate(toDate),
    });
    setShowCustom(false);
  };

  const handleCustomApply = () => {
    if (customFrom && customTo) {
      onChange({ from: customFrom, to: customTo });
      setShowCustom(false);
    }
  };

  const handleCustomToggle = () => {
    setShowCustom(!showCustom);
    if (!showCustom) {
      setCustomFrom(from);
      setCustomTo(to);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 items-center flex-wrap">
        <button
          onClick={() => handlePresetClick(7)}
          className="px-3 py-1.5 rounded text-sm border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          Last 7 days
        </button>
        <button
          onClick={() => handlePresetClick(30)}
          className="px-3 py-1.5 rounded text-sm border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          Last 30 days
        </button>
        <button
          onClick={() => handlePresetClick(90)}
          className="px-3 py-1.5 rounded text-sm border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          Last 90 days
        </button>
        <button
          onClick={handleCustomToggle}
          className="px-3 py-1.5 rounded text-sm border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
        >
          <Calendar className="w-4 h-4" />
          Custom
        </button>
      </div>
      
      {showCustom && (
        <div className="flex gap-2 items-center p-3 bg-gray-50 dark:bg-gray-800 rounded">
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600 dark:text-gray-400">From:</label>
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600 dark:text-gray-400">To:</label>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm"
            />
          </div>
          <button
            onClick={handleCustomApply}
            className="px-3 py-1 rounded text-sm bg-primary-600 text-white hover:bg-primary-700"
          >
            Apply
          </button>
          <button
            onClick={() => setShowCustom(false)}
            className="px-3 py-1 rounded text-sm border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
        </div>
      )}
      
      <div className="text-xs text-gray-500 dark:text-gray-400">
        Selected: {from} to {to}
      </div>
    </div>
  );
}

export default DateRangePicker;
