import { useState, useEffect } from 'react';

/**
 * Debounce hook for search inputs.
 * 
 * @param {*} value - Value to debounce
 * @param {number} delay - Delay in ms
 * @returns {*} Debounced value
 */
export function useDebounce(value, delay = 500) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);

  return debouncedValue;
}
