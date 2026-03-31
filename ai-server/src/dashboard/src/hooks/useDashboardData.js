import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/dashboardApi';

/**
 * Custom hook that manages all dashboard data and CRUD operations.
 * Single source of truth for the entire dashboard state.
 * Uses REST API calls instead of Forge bridge invoke().
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
      const result = await api.getData();
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
  const mutate = async (apiFn, ...args) => {
    setSaving(true);
    try {
      const result = await apiFn(...args);
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
  const addMetric = (payload) => mutate(api.addMetric, payload);
  const updateMetric = (payload) => {
    const { id, ...rest } = payload;
    return mutate(api.updateMetric, id, rest);
  };
  const deleteMetric = (id) => mutate(api.deleteMetric, id);

  // ── ORGANIZATIONS ──
  const addOrg = (payload) => mutate(api.addOrg, payload);
  const updateOrg = (payload) => {
    const { id, ...rest } = payload;
    return mutate(api.updateOrg, id, rest);
  };
  const deleteOrg = (id) => mutate(api.deleteOrg, id);

  // ── TICKETS PER TEAM ──
  const addTicketTeam = (payload) => mutate(api.addTicketTeam, payload);
  const updateTicketTeam = (payload) => {
    const { id, ...rest } = payload;
    return mutate(api.updateTicketTeam, id, rest);
  };
  const deleteTicketTeam = (id) => mutate(api.deleteTicketTeam, id);

  // ── TICKET STATUS ──
  const addTicketStatus = (payload) => mutate(api.addTicketStatus, payload);
  const updateTicketStatus = (payload) => {
    const { id, ...rest } = payload;
    return mutate(api.updateTicketStatus, id, rest);
  };
  const deleteTicketStatus = (id) => mutate(api.deleteTicketStatus, id);

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
