/**
 * FilterPanel Component
 * 
 * TODO: Implement collapsible filter panel with:
 * - Collapsible header
 * - Filter inputs
 * - Apply/Clear buttons
 */

function FilterPanel({ children, onApply, onClear }) {
  return (
    <div className="card mb-4">
      <div className="space-y-4">
        {children}
      </div>
      <div className="flex gap-2 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
        <button onClick={onApply} className="btn-primary">
          Apply Filters
        </button>
        <button onClick={onClear} className="btn-secondary">
          Clear
        </button>
      </div>
    </div>
  );
}

export default FilterPanel;
