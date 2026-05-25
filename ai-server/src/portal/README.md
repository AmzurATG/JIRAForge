# Portal Frontend

React-based web productivity portal for viewing employee analytics and reports.

**Live URL (dev):** http://localhost:3002

## Quick Start

**Prerequisites:** Backend (ai-server) must be running on port 8080.

```bash
# Install dependencies
npm install

# Copy environment file (optional - defaults work for local dev)
cp .env.example .env

# Start development server
npm run dev
```

Portal will run on http://localhost:3002 and proxy API requests to http://localhost:8080.

## Features

- **Dashboard**: KPIs, charts, daily trends, top apps/employees
- **Employees**: List with stats, individual details, search/filter
- **Time Logs**: Activity logs with advanced filtering and sorting
- **Reports**: Generate and export (CSV/PDF) activity reports with pagination
- **Settings**: User profile and organization management

## Complete Setup Guide

See **[PORTAL_SETUP_GUIDE.md](../../../docs/PORTAL_SETUP_GUIDE.md)** for:
- Complete setup instructions (backend + frontend)
- Login credential creation
- Production deployment
- Troubleshooting
- API documentation
- Security considerations

## Build

```bash
npm run build
```

Output will be in `build/` directory.

## Structure

- `src/api/` — API client functions
- `src/components/` — Reusable UI components
  - `common/` — Generic components (DataTable, ErrorBanner, KPICard, etc.)
  - `layout/` — Layout components (Sidebar, Header, PageWrapper)
- `src/contexts/` — Auth context
- `src/hooks/` — Custom hooks (useDebounce, etc.)
- `src/pages/` — Page components
  - `DashboardPage.jsx`
  - `EmployeesPage.jsx`
  - `TimeLogsPage.jsx`
  - `ReportsPage.jsx`
  - `SettingsPage.jsx`
- `src/utils/` — Helper functions (formatters, validators)
