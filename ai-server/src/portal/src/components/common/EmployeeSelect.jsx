/**
 * EmployeeSelect Component
 *
 * Searchable employee dropdown (combobox): type to filter the list as you go.
 * Filtering is client-side over an already-loaded employee list, so it's instant
 * and makes no extra API calls. Mirrors the look of the standard `.select-field`.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { ChevronDown, Search, Check } from 'lucide-react';

function EmployeeSelect({ employees = [], value, onChange, placeholder = 'All Employees' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus the search box as soon as the dropdown opens
  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  const selected = employees.find((e) => e.userId === value);
  const label = selected ? (selected.name || selected.email || 'Unknown') : placeholder;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter(
      (e) =>
        (e.name && e.name.toLowerCase().includes(q)) ||
        (e.email && e.email.toLowerCase().includes(q))
    );
  }, [employees, query]);

  const select = (userId) => {
    onChange(userId);
    setOpen(false);
    setQuery('');
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-2.5 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 cursor-pointer flex items-center justify-between gap-2 focus:ring-1 focus:ring-primary-500/50 focus:border-primary-500 transition-all duration-200"
      >
        <span className={`truncate ${selected ? '' : 'text-gray-500 dark:text-gray-400'}`}>{label}</span>
        <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          {/* Search box */}
          <div className="p-2 border-b border-gray-100 dark:border-gray-700">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search employees..."
                className="w-full pl-7 pr-2 py-1.5 text-xs rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-primary-500/50 focus:border-primary-500"
              />
            </div>
          </div>

          {/* Options */}
          <div className="max-h-56 overflow-y-auto">
            <button
              type="button"
              onClick={() => select('')}
              className={`w-full px-3 py-2 text-xs text-left flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${
                !value ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400 font-medium' : 'text-gray-700 dark:text-gray-300'
              }`}
            >
              {placeholder}
              {!value && <Check className="w-3.5 h-3.5" />}
            </button>

            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-xs text-gray-500 dark:text-gray-400 text-center">No employees found</p>
            ) : (
              filtered.map((emp) => (
                <button
                  key={emp.userId}
                  type="button"
                  onClick={() => select(emp.userId)}
                  className={`w-full px-3 py-2 text-xs text-left flex items-center justify-between gap-2 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${
                    value === emp.userId ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400 font-medium' : 'text-gray-700 dark:text-gray-300'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{emp.name || 'Unknown'}</span>
                    {emp.email && emp.name !== emp.email && (
                      <span className="block truncate text-[10px] text-gray-400 dark:text-gray-500">{emp.email}</span>
                    )}
                  </span>
                  {value === emp.userId && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default EmployeeSelect;
