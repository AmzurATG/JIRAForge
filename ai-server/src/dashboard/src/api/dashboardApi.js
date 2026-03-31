/**
 * Dashboard API client.
 * Wraps fetch() with the Atlassian OAuth token from sessionStorage.
 */

const TOKEN_KEY = 'atl_dashboard_token';

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

async function request(url, options = {}) {
  const token = getToken();
  if (!token) {
    return { success: false, error: 'Not authenticated' };
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options.headers
    }
  });

  if (response.status === 401) {
    // Token expired — clear and signal logout
    sessionStorage.removeItem(TOKEN_KEY);
    window.location.reload();
    return { success: false, error: 'Session expired' };
  }

  return response.json();
}

export const api = {
  // READ
  getData: () => request('/api/dashboard/data'),

  // HEADER METRICS
  addMetric: (data) => request('/api/dashboard/metrics', { method: 'POST', body: JSON.stringify(data) }),
  updateMetric: (id, data) => request(`/api/dashboard/metrics/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteMetric: (id) => request(`/api/dashboard/metrics/${id}`, { method: 'DELETE' }),

  // ORGANIZATIONS
  addOrg: (data) => request('/api/dashboard/organizations', { method: 'POST', body: JSON.stringify(data) }),
  updateOrg: (id, data) => request(`/api/dashboard/organizations/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteOrg: (id) => request(`/api/dashboard/organizations/${id}`, { method: 'DELETE' }),

  // TICKETS PER TEAM
  addTicketTeam: (data) => request('/api/dashboard/ticket-teams', { method: 'POST', body: JSON.stringify(data) }),
  updateTicketTeam: (id, data) => request(`/api/dashboard/ticket-teams/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteTicketTeam: (id) => request(`/api/dashboard/ticket-teams/${id}`, { method: 'DELETE' }),

  // TICKET STATUS
  addTicketStatus: (data) => request('/api/dashboard/ticket-statuses', { method: 'POST', body: JSON.stringify(data) }),
  updateTicketStatus: (id, data) => request(`/api/dashboard/ticket-statuses/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteTicketStatus: (id) => request(`/api/dashboard/ticket-statuses/${id}`, { method: 'DELETE' })
};
