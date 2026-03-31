import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@forge/bridge';

/**
 * Custom hook that manages all dashboard data and CRUD operations.
 * Single source of truth for the entire dashboard state.
 */
export default function useDashboardData() {
  const [data, setData] = useState({
    metrics: [],
    organizations: [],
    ticketsPerTeam: [],
    ticketStatuses: []
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke('getDashboardData');
      if (result.success) {
        setData(result.data);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError('Failed to load dashboard data: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Generic mutation wrapper ──
  const mutate = async (resolverName, payload) => {
    setSaving(true);
    try {
      const result = await invoke(resolverName, payload);
      if (result.success) {
        await loadData(); // Refresh everything
        return { success: true, data: result.data };
      } else {
        return { success: false, error: result.error };
      }
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      setSaving(false);
    }
  };

  // ── HEADER METRICS ──
  const addMetric = (payload) => mutate('addDashboardMetric', payload);
  const updateMetric = (payload) => mutate('updateDashboardMetric', payload);
  const deleteMetric = (id) => mutate('deleteDashboardMetric', { id });

  // ── ORGANIZATIONS ──
  const addOrg = (payload) => mutate('addDashboardOrg', payload);
  const updateOrg = (payload) => mutate('updateDashboardOrg', payload);
  const deleteOrg = (id) => mutate('deleteDashboardOrg', { id });

  // ── TICKETS PER TEAM ──
  const addTicketTeam = (payload) => mutate('addDashboardTicketTeam', payload);
  const updateTicketTeam = (payload) => mutate('updateDashboardTicketTeam', payload);
  const deleteTicketTeam = (id) => mutate('deleteDashboardTicketTeam', { id });

  // ── TICKET STATUS ──
  const addTicketStatus = (payload) => mutate('addDashboardTicketStatus', payload);
  const updateTicketStatus = (payload) => mutate('updateDashboardTicketStatus', payload);
  const deleteTicketStatus = (id) => mutate('deleteDashboardTicketStatus', { id });

  return {
    ...data,
    loading,
    error,
    saving,
    reload: loadData,
    // Metrics
    addMetric, updateMetric, deleteMetric,
    // Organizations
    addOrg, updateOrg, deleteOrg,
    // Tickets per team
    addTicketTeam, updateTicketTeam, deleteTicketTeam,
    // Ticket status
    addTicketStatus, updateTicketStatus, deleteTicketStatus
  };
}
