/**
 * LOB (Line of Business) API
 */

import apiClient from './client';

export const lobsApi = {
  /** List LOBs visible to the caller (superadmin: all; head: their LOBs). */
  async list(params) {
    const response = await apiClient.get('/api/portal/lobs', { params });
    return response.data;
  },

  /** Create an LOB (superadmin). */
  async create(data) {
    const response = await apiClient.post('/api/portal/lobs', data);
    return response.data;
  },

  /** Update an LOB (superadmin). */
  async update(lobId, data) {
    const response = await apiClient.put(`/api/portal/lobs/${lobId}`, data);
    return response.data;
  },

  /** Delete an LOB (superadmin). */
  async remove(lobId) {
    const response = await apiClient.delete(`/api/portal/lobs/${lobId}`);
    return response.data;
  },

  // --- Members (employees) ---

  async listMembers(lobId, params) {
    const response = await apiClient.get(`/api/portal/lobs/${lobId}/members`, { params });
    return response.data;
  },

  async addMembers(lobId, userIds) {
    const response = await apiClient.post(`/api/portal/lobs/${lobId}/members`, { userIds });
    return response.data;
  },

  async removeMember(lobId, userId) {
    const response = await apiClient.delete(`/api/portal/lobs/${lobId}/members/${userId}`);
    return response.data;
  },

  // --- Heads (superadmin) ---

  async listHeads(lobId) {
    const response = await apiClient.get(`/api/portal/lobs/${lobId}/heads`);
    return response.data;
  },

  async addHeads(lobId, adminIds) {
    const response = await apiClient.post(`/api/portal/lobs/${lobId}/heads`, { adminIds });
    return response.data;
  },

  async removeHead(lobId, adminId) {
    const response = await apiClient.delete(`/api/portal/lobs/${lobId}/heads/${adminId}`);
    return response.data;
  },
};

export default lobsApi;
