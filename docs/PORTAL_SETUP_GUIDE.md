# Web Admin Portal Setup Guide

## Overview

The Web Admin Portal is a standalone React application that provides analytics and reporting for employee productivity tracking. It displays activity logs, daily summaries, employee statistics, and reports.

**Tech Stack:**
- Frontend: React 18 + Vite 4.5 + Tailwind CSS 3
- Backend: Node.js Express (ai-server)
- Database: Supabase PostgreSQL

**Access URL:** http://localhost:3002 (development)

---

## Prerequisites

1. **Node.js**: Version ≥20
2. **Supabase**: Running instance with portal tables (see [Supabase setup](./DEPLOYMENT_GUIDE_V3.md))
3. **AI Server Backend**: Must be running on port 8080

---

## Quick Start

### 1. Backend Setup (AI Server)

Navigate to the AI server directory and configure:

```bash
cd ai-server
cp .env.example .env
npm install
```

**Edit `.env` with required values:**

```env
# Server Configuration
PORT=8080
NODE_ENV=development

# Supabase Configuration (REQUIRED)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key_here
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
SUPABASE_JWT_SECRET=your_jwt_secret_here

# Portal Authentication
PORTAL_JWT_SECRET=your_portal_jwt_secret_here
```

**Start the backend:**

```bash
npm run dev
```

The backend API will run on **http://localhost:8080**

---

### 2. Frontend Setup (Portal)

Navigate to the portal directory:

```bash
cd ai-server/src/portal
cp .env.example .env
npm install
```

**Edit `.env` (optional - defaults work for local dev):**

```env
# API Base URL (defaults to proxy via Vite)
VITE_API_BASE_URL=http://localhost:8080
```

**Start the frontend:**

```bash
npm run dev
```

The portal will run on **http://localhost:3002**

---

## Accessing the Portal

### Login Credentials

The portal uses JWT authentication. You need to create a portal user in Supabase:

**Method 1: Using Supabase Dashboard**

1. Go to your Supabase project → Table Editor
2. Open the `portal_users` table
3. Insert a new row:
   - `email`: your-email@company.com
   - `password_hash`: Use bcrypt to hash your password (bcrypt rounds: 10)
   - `name`: Your Name
   - `organization_id`: Your org ID (matches `organizations.id`)
   - `role`: `admin` or `superadmin`

**Method 2: Using SQL**

```sql
-- Create organization first
INSERT INTO organizations (id, name) 
VALUES ('b8f600a2-1dfc-4bde-852f-493bcfeb986a', 'Amzur Technologies')
ON CONFLICT (id) DO NOTHING;

-- Create portal user (replace password hash with your bcrypt hash)
INSERT INTO portal_users (email, password_hash, name, organization_id, role)
VALUES (
  'admin@example.com',
  '$2a$10$hashedpasswordhere',  -- bcrypt hash of your password
  'Admin User',
  'b8f600a2-1dfc-4bde-852f-493bcfeb986a',
  'superadmin'
);
```

**Generate bcrypt hash in Node.js:**

```javascript
const bcrypt = require('bcrypt');
const hash = await bcrypt.hash('yourpassword', 10);
console.log(hash);
```

### Login to Portal

1. Open http://localhost:3002
2. Enter your email and password
3. You'll be redirected to the Dashboard

---

## Portal Features

### 1. **Dashboard**
- KPI cards: Total Hours, Productive Hours, Productivity %, Active Employees
- Daily productivity trend chart (last 30 days)
- Top applications usage
- Top employees by hours

### 2. **Employees**
- List of all employees with activity statistics
- Search and filter by name/email
- View individual employee details
- Date range filtering

### 3. **Time Logs**
- Comprehensive activity logs with timestamps
- Filters: Classification, Employee, Application, Date Range
- Advanced filters: Duration, Confidence Score
- Column visibility toggle
- Sortable and searchable table

### 4. **Reports**
- **Activity Logs**: Detailed log of all activities
- **Daily Summary**: Aggregated hours per day
- **Employee Summary**: Total hours per employee
- **Application Usage**: Time spent per application
- Export options: CSV, PDF
- Pagination support (20 rows per page)

### 5. **Settings**
- User profile management
- Organization settings
- Role-based access control

---

## Architecture

### Data Flow

```
Desktop App → Supabase → AI Server → Portal UI
     ↓           ↓           ↓           ↓
  Screenshots  activity_   Portal      React
  + OCR text   records     Service     Components
```

### API Endpoints

**Authentication:**
- `POST /api/portal/auth/login` - Login with email/password
- `POST /api/portal/auth/logout` - Logout
- `GET /api/portal/auth/me` - Get current user

**Analytics:**
- `GET /api/portal/dashboard` - Dashboard KPIs and charts
- `GET /api/portal/employees` - Employee list with stats
- `GET /api/portal/employees/list` - Simple employee list (for filters)
- `GET /api/portal/employees/:id` - Individual employee details
- `GET /api/portal/time-logs` - Activity logs with filtering

**Reports:**
- `GET /api/portal/reports/data` - Report preview with pagination
- `GET /api/portal/reports/export/csv` - Export CSV
- `GET /api/portal/reports/export/pdf` - Export PDF

---

## Development Tips

### Hot Reload

Both frontend and backend support hot reload:
- **Frontend**: Vite HMR (instant updates)
- **Backend**: Nodemon (restarts on file changes)

### API Proxy

Vite proxies `/api/*` requests to `http://localhost:8080`. No CORS issues in development.

### Browser DevTools

- **React DevTools**: Install Chrome extension for component inspection
- **Redux DevTools**: Not used (using Context API)
- **Network Tab**: Monitor API calls and responses

### Database Access

Use Supabase Studio (http://localhost:54323) to:
- Query `activity_records` table
- Manage `portal_users` and `organizations`
- View RLS policies

---

## Production Build

### Build Frontend

```bash
cd ai-server/src/portal
npm run build
```

Output: `build/` directory with static assets.

### Serve via AI Server

The AI server serves the built portal at the root path (`/`):

```javascript
// ai-server/src/index.js
app.use(express.static(path.join(__dirname, 'portal/build')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'portal/build/index.html'));
});
```

### Deploy

1. Build the portal: `npm run build`
2. Deploy ai-server to your hosting (e.g., AWS EC2, DigitalOcean)
3. Set environment variables in production
4. Ensure Supabase is accessible from production
5. Configure reverse proxy (Nginx) for SSL/domain

**Example Nginx config:**

```nginx
server {
  listen 80;
  server_name portal.example.com;

  location / {
    proxy_pass http://localhost:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
  }
}
```

---

## Troubleshooting

### Issue: "Failed to fetch" / Network errors

**Solution:**
- Verify backend is running on port 8080: `curl http://localhost:8080/health`
- Check Vite proxy config in `vite.config.js`
- Clear browser cache

### Issue: "Invalid credentials" on login

**Solution:**
- Verify user exists in `portal_users` table
- Check password hash is correct (bcrypt)
- Ensure `PORTAL_JWT_SECRET` is set in backend `.env`

### Issue: Empty data / No activity records

**Solution:**
- Check if desktop app is capturing data
- Query Supabase directly: `SELECT COUNT(*) FROM activity_records;`
- Verify organization_id matches in filters
- Check date range (default is last 7/30 days)

### Issue: "Employee filter not loading"

**Solution:**
- This is fixed in latest version with `/api/portal/employees/list` endpoint
- Verify backend has `getEmployeesList()` in portal-service.js
- Check browser console for errors

### Issue: Horizontal scrolling required

**Solution:**
- Fixed in latest version with proper overflow handling
- Verify PageWrapper has `overflow-hidden` on root div
- Check that DataTable has responsive classes

---

## Configuration Reference

### Environment Variables

**Frontend (.env in portal directory):**
```env
VITE_API_BASE_URL=http://localhost:8080  # Backend API URL
```

**Backend (.env in ai-server directory):**
```env
PORT=8080                                 # Backend port
SUPABASE_URL=https://xxx.supabase.co     # Database URL
SUPABASE_ANON_KEY=xxx                    # Supabase anon key
SUPABASE_SERVICE_ROLE_KEY=xxx            # Service role key
SUPABASE_JWT_SECRET=xxx                  # JWT verification
PORTAL_JWT_SECRET=xxx                    # Portal auth secret
```

### Default Settings

- **Pagination**: 20 rows per page
- **Date Ranges**:
  - Dashboard: Last 30 days
  - Time Logs: Last 7 days (default)
  - Employees: Last 30 days
  - Reports: Last 7 days (default)
- **Min Confidence**: 40% (AI matching threshold)
- **Session Timeout**: 24 hours

---

## Security Considerations

1. **Authentication**: JWT tokens stored in localStorage
2. **Authorization**: Role-based access (admin, superadmin, viewer)
3. **CORS**: Configured in backend for production domains
4. **RLS Policies**: Supabase enforces org_id filtering (now disabled for cross-org access per requirements)
5. **SQL Injection**: All queries use parameterized statements
6. **XSS Protection**: React sanitizes output by default

---

## Support

For issues or questions:
1. Check [docs/](../docs/) for architecture and troubleshooting
2. Review [CLAUDE.md](../CLAUDE.md) for project context
3. Check backend logs: `tail -f ai-server/logs/app.log`
4. Check Supabase logs in dashboard

---

## Recent Updates

**May 24, 2026:**
- ✅ Implemented compact UI design (reduced spacing, fonts, padding)
- ✅ Added collapsible sidebar with localStorage persistence
- ✅ Converted date range buttons to dropdown menu
- ✅ Added pagination to Reports page (20 rows per page)
- ✅ Fixed employee filter loading issue with new optimized endpoint
- ✅ Fixed navigation blink by restructuring Suspense boundaries
- ✅ Fixed horizontal scrolling with proper overflow handling
- ✅ Added cross-org data access (removed org_id filtering per requirements)
- ✅ Optimized queries with default date ranges to prevent timeouts

**Known Limitations:**
- Reports preview limited to first 50,000 records before pagination
- Daily Summary only shows days with activity (0-hour days excluded)
- PDF export requires all data to fit in memory (use CSV for large exports)

---

## Next Steps

**Recommended Improvements:**
1. Add real-time updates via Supabase subscriptions
2. Implement data caching for faster page loads
3. Add advanced filters (tags, custom fields)
4. Create scheduled report emails
5. Add data export scheduling
6. Implement user activity audit logs
7. Add dark mode toggle in settings
8. Create mobile-responsive design
