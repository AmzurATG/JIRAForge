import { useState } from 'react';
import { formatDate } from '../utils/formatters';

/**
 * Hook for managing date range state.
 * 
 * @param {string} defaultPreset - 'last_7_days', 'last_30_days', etc.
 * @returns {Object} { from, to, preset, setDateRange }
 */
export function useDateRange(defaultPreset = 'last_30_days') {
  const [preset, setPreset] = useState(defaultPreset);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const calculateDates = (presetValue) => {
    const today = new Date();
    const toDate = formatDate(today);
    
    let fromDate;
    switch (presetValue) {
      case 'last_7_days':
        fromDate = formatDate(new Date(today.setDate(today.getDate() - 7)));
        break;
      case 'last_30_days':
        fromDate = formatDate(new Date(today.setDate(today.getDate() - 30)));
        break;
      case 'last_90_days':
        fromDate = formatDate(new Date(today.setDate(today.getDate() - 90)));
        break;
      default:
        fromDate = toDate;
    }
    
    setFrom(fromDate);
    setTo(toDate);
  };

  const setDateRange = (newPreset, customFrom = null, customTo = null) => {
    setPreset(newPreset);
    
    if (newPreset === 'custom' && customFrom && customTo) {
      setFrom(customFrom);
      setTo(customTo);
    } else {
      calculateDates(newPreset);
    }
  };

  // Initialize on mount
  useState(() => {
    calculateDates(defaultPreset);
  }, []);

  return {
    from,
    to,
    preset,
    setDateRange,
  };
}
