/**
 * CategoryLegend — ⓘ popover defining the canonical activity categories
 * (AC-C2). One shared definition so every page explains the numbers the
 * same way.
 */

import { useState, useRef, useEffect } from 'react';
import { Info } from 'lucide-react';

const DEFINITIONS = [
  ['Productive', 'Time in applications classified as work-related.'],
  ['Non-Productive', 'Time in applications classified as not work-related.'],
  ['Neutral', 'Tracked time that is unclassified or private — counted as time, excluded from the productivity ratio.'],
  ['Idle', 'No user activity (away, screen locked, or system asleep).'],
  ['Active Time', 'Productive + Non-Productive + Neutral.'],
  ['Office Time', 'Active Time + Idle.'],
  ['Productivity %', 'Productive ÷ (Productive + Non-Productive).'],
];

function CategoryLegend() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="p-1 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50"
        title="What do these categories mean?"
      >
        <Info className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute left-0 mt-2 w-80 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 z-30 p-3">
          <h4 className="text-xs font-semibold text-gray-900 dark:text-gray-100 mb-2">Time categories</h4>
          <dl className="space-y-1.5">
            {DEFINITIONS.map(([term, def]) => (
              <div key={term} className="text-xs">
                <dt className="inline font-semibold text-gray-700 dark:text-gray-300">{term}: </dt>
                <dd className="inline text-gray-500 dark:text-gray-400">{def}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

export default CategoryLegend;
