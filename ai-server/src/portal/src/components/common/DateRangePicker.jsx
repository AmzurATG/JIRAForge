/**
 * DateRangePicker Component
 * 
 * Date range picker with preset dropdown and custom date inputs.
 */

import { useState, useEffect, useRef } from 'react';
import { Calendar, Check, ChevronDown } from 'lucide-react';
import { formatDate } from '../../utils/formatters';

function DateRangePicker({ from, to, onChange }) {
  const [customFrom, setCustomFrom] = useState(from);
  const [customTo, setCustomTo] = useState(to);
  const [showCustom, setShowCustom] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [activePreset, setActivePreset] = useState(null);
  const dropdownRef = useRef(null);

  // Sync customFrom/To when from/to props change
  useEffect(() => {
    setCustomFrom(from);
    setCustomTo(to);
    
    // Auto-detect which preset matches the current date range
    const today = formatDate(new Date());
    if (to === today) {
      const presets = [
        { days: 0, name: 'today' },
        { days: 7, name: '7d' },
        { days: 30, name: '30d' },
        { days: 90, name: '90d' },
      ];
      
      for (const preset of presets) {
        const expectedFrom = new Date();
        expectedFrom.setDate(expectedFrom.getDate() - preset.days);
        if (from === formatDate(expectedFrom)) {
          setActivePreset(preset.name);
          return;
        }
      }
    }
    
    // If no preset matches, it's a custom range
    setActivePreset('custom');
  }, [from, to]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handlePresetClick = (days, presetName) => {
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(toDate.getDate() - days);
    
    onChange({
      from: formatDate(fromDate),
      to: formatDate(toDate),
    });
    setShowCustom(false);
    setActivePreset(presetName);
    setShowDropdown(false);
  };

  const handleCustomApply = () => {
    if (customFrom && customTo) {
      onChange({ from: customFrom, to: customTo });
      setShowCustom(false);
      setActivePreset('custom');
    }
  };

  const handleCustomToggle = () => {
    setShowCustom(!showCustom);
    if (!showCustom) {
      setCustomFrom(from);
      setCustomTo(to);
      setActivePreset('custom');
    }
    setShowDropdown(false);
  };

  const presets = [
    { days: 0, label: 'Today', name: 'today' },
    { days: 7, label: 'Last 7 days', name: '7d' },
    { days: 30, label: 'Last 30 days', name: '30d' },
    { days: 90, label: 'Last 90 days', name: '90d' },
  ];

  const getActiveLabel = () => {
    if (activePreset === 'custom') return 'Custom Range';
    const preset = presets.find(p => p.name === activePreset);
    return preset ? preset.label : 'Select Range';
  };

  return (
    <div className="space-y-2">
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          className="w-full px-3 py-1.5 text-xs bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 rounded-lg hover:border-primary-300 dark:hover:border-primary-700 transition-colors flex items-center justify-between gap-2"
        >
          <div className="flex items-center gap-1.5">
            <Calendar className="w-3 h-3" />
            <span>{getActiveLabel()}</span>
          </div>
          <ChevronDown className={`w-3 h-3 transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
        </button>

        {showDropdown && (
          <div className="absolute z-20 mt-1 w-full bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            {presets.map(({ days, label, name }) => (
              <button
                key={name}
                onClick={() => handlePresetClick(days, name)}
                className={`w-full px-3 py-2 text-xs text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${
                  activePreset === name
                    ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400 font-medium'
                    : 'text-gray-700 dark:text-gray-300'
                }`}
              >
                {label}
              </button>
            ))}
            <button
              onClick={handleCustomToggle}
              className={`w-full px-3 py-2 text-xs text-left flex items-center gap-1.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors border-t border-gray-100 dark:border-gray-700 ${
                activePreset === 'custom'
                  ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400 font-medium'
                  : 'text-gray-700 dark:text-gray-300'
              }`}
            >
              <Calendar className="w-3 h-3" />
              Custom Range
            </button>
          </div>
        )}
      </div>
      
      {showCustom && (
        <div className="flex flex-col gap-2 p-3 bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1">Start Date</label>
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-gray-500 dark:text-gray-400 mb-1">End Date</label>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCustomApply}
              className="flex-1 px-3 py-1.5 rounded bg-primary-600 text-white text-xs font-medium hover:bg-primary-700 transition-colors flex items-center justify-center gap-1.5"
            >
              <Check className="w-3 h-3" />
              Apply
            </button>
            <button
              onClick={() => setShowCustom(false)}
              className="flex-1 px-3 py-1.5 rounded text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      
      <p className="text-[10px] text-gray-500 dark:text-gray-400 flex items-center gap-1">
        <span>Selected:</span>
        <span className="font-medium text-gray-700 dark:text-gray-300">{from}</span>
        <span>to</span>
        <span className="font-medium text-gray-700 dark:text-gray-300">{to}</span>
      </p>
    </div>
  );
}

export default DateRangePicker;
