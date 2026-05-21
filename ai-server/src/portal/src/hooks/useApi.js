import { useState, useEffect } from 'react';

/**
 * Generic API fetch hook with loading and error states.
 * 
 * @param {Function} apiFn - API function to call
 * @param {*} defaultValue - Default value while loading
 * @returns {Object} { data, loading, error, refetch }
 */
export function useApi(apiFn, defaultValue = null) {
  const [data, setData] = useState(defaultValue);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await apiFn();
      setData(result);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  return {
    data,
    loading,
    error,
    refetch: fetchData,
  };
}
