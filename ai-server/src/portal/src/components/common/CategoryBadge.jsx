/**
 * CategoryBadge — canonical activity-category badge (AC-C3).
 *
 * Four distinct states so private/unknown time is no longer mislabeled as
 * non-productive: productive (green), non-productive (red), neutral
 * (blue-grey), idle (grey). Accepts either the canonical `category` or a raw
 * `classification` value (both spellings of non-productive).
 */

const STYLES = {
  productive: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  'non-productive': 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  neutral: 'bg-slate-100 text-slate-700 dark:bg-slate-700/60 dark:text-slate-300',
  idle: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
};

export function toCategory(value) {
  if (!value) return 'neutral';
  if (value === 'productive') return 'productive';
  if (value === 'non-productive' || value === 'non_productive') return 'non-productive';
  if (value === 'idle') return 'idle';
  return 'neutral';
}

function CategoryBadge({ value }) {
  const category = toCategory(value);
  return (
    <span className={`px-2 py-1 rounded text-xs font-semibold ${STYLES[category]}`}>
      {category}
    </span>
  );
}

export default CategoryBadge;
