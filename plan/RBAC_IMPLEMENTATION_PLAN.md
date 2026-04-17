# Role-Based Access Control (RBAC) Implementation Plan

## Overview

This document outlines the complete process for implementing role-based access control in the BRD & Time Tracker Jira Forge application. The system will support multiple user roles with different permissions and access levels.

---

## 1. User Roles & Permissions Matrix

### Role Definitions

| Role | Description | Key Characteristics |
|------|-------------|---------------------|
| **Admin** | System administrator | Full access to all features, can configure settings, view all data |
| **Project Manager** | Manages projects and teams | Can view team analytics, manage BRD uploads, view all screenshots in projects |
| **Developer** | Individual contributor | Can view own analytics, own screenshots, limited BRD access |
| **Viewer** | Read-only access | Can view analytics and screenshots (own or team-based), no write access |

### Detailed Permissions Matrix

| Feature | Admin | Project Manager | Developer | Viewer |
|---------|-------|----------------|-----------|--------|
| **Settings Page** | ✅ Full Access | ❌ No Access | ❌ No Access | ❌ No Access |
| **Time Analytics - Own Data** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| **Time Analytics - Team Data** | ✅ Yes | ✅ Yes | ❌ No | ✅ Yes (read-only) |
| **Time Analytics - All Projects** | ✅ Yes | ✅ Yes (assigned projects) | ❌ No | ❌ No |
| **Screenshot Gallery - Own** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes (view only) |
| **Screenshot Gallery - Team** | ✅ Yes | ✅ Yes | ❌ No | ✅ Yes (view only) |
| **Screenshot Gallery - All** | ✅ Yes | ❌ No | ❌ No | ❌ No |
| **Delete Screenshots** | ✅ Yes (all) | ✅ Yes (team) | ✅ Yes (own) | ❌ No |
| **BRD Upload** | ✅ Yes | ✅ Yes | ✅ Yes (own projects) | ❌ No |
| **Create Issues from BRD** | ✅ Yes | ✅ Yes | ❌ No | ❌ No |
| **View BRD Status** | ✅ Yes | ✅ Yes | ✅ Yes (own) | ✅ Yes (read-only) |
| **Configure App Settings** | ✅ Yes | ❌ No | ❌ No | ❌ No |

---

## 2. Implementation Architecture

### 2.1 Role Detection Strategy

#### Option A: Jira Project Roles (Recommended)
- Use Jira's built-in project roles (Administrator, Developer, etc.)
- Check user's role in the current project context
- Pros: Native Jira integration, no additional setup
- Cons: Limited to project-level roles

#### Option B: Jira Application Roles
- Use Jira application roles (jira-administrators, jira-software-users)
- Check global permissions
- Pros: System-wide access control
- Cons: Less granular control

#### Option C: Custom Role Mapping
- Store role mappings in Supabase or Forge storage
- Map Jira users to custom roles
- Pros: Full flexibility
- Cons: Requires manual configuration

**Recommended Approach: Hybrid (A + C)**
- Primary: Use Jira project roles for project-level access
- Secondary: Use custom role mapping for system-wide admin access
- Fallback: Default to Developer role if no role found

### 2.2 Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    User Access Request                       │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 1: Get User Role                                      │
│  - Call Jira API: /rest/api/3/user                         │
│  - Check project roles: /rest/api/3/project/{projectId}/role │
│  - Check custom role mapping (Supabase/Storage)             │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 2: Determine Permissions                             │
│  - Match role to permission matrix                          │
│  - Check project context                                    │
│  - Return allowed actions                                   │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 3: Filter Data Based on Role                          │
│  - Time Analytics: Filter by user_id or project            │
│  - Screenshots: Filter by user_id or project                │
│  - BRD Documents: Filter by user_id or project            │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Step 4: Render UI Based on Permissions                     │
│  - Show/hide UI components                                  │
│  - Enable/disable buttons                                   │
│  - Display appropriate data                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Implementation Components

### 3.1 Backend (Forge Resolvers)

#### New Resolver: `getUserRole`
```javascript
// Purpose: Get user's role in current project/context
// Returns: { role: 'admin'|'project_manager'|'developer'|'viewer', permissions: {...} }
```

#### New Resolver: `getUserPermissions`
```javascript
// Purpose: Get detailed permissions for current user
// Returns: { canViewAllAnalytics, canUploadBRD, canDeleteScreenshots, ... }
```

#### Modified Resolvers:
- `getTimeAnalytics` - Add role-based filtering
- `getScreenshots` - Add role-based filtering
- `deleteScreenshot` - Add permission check
- `uploadBRD` - Add permission check
- `createIssuesFromBRD` - Add permission check

### 3.2 Frontend (React Components)

#### New Component: `RoleBasedWrapper`
```javascript
// Purpose: Conditionally render components based on user role
<RoleBasedWrapper allowedRoles={['admin', 'project_manager']}>
  <SettingsButton />
</RoleBasedWrapper>
```

#### Modified Components:
- `App.js` - Add role state, conditionally show tabs/sections
- `TimeAnalytics` - Show/hide team data based on role
- `ScreenshotGallery` - Filter and show delete buttons based on role
- `BRDUpload` - Show/hide upload and create issues buttons

### 3.3 Database Schema Updates

#### New Table: `user_roles` (Supabase)
```sql
CREATE TABLE user_roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  role VARCHAR(50) NOT NULL, -- 'admin', 'project_manager', 'developer', 'viewer'
  project_key VARCHAR(50), -- NULL for global roles
  assigned_by UUID REFERENCES users(id),
  assigned_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, project_key)
);
```

#### New Table: `role_permissions` (Supabase)
```sql
CREATE TABLE role_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role VARCHAR(50) NOT NULL,
  permission_key VARCHAR(100) NOT NULL,
  allowed BOOLEAN DEFAULT true,
  UNIQUE(role, permission_key)
);
```

---

## 4. Implementation Steps

### Phase 1: Foundation (Week 1)

1. **Create Database Schema**
   - Create `user_roles` table
   - Create `role_permissions` table
   - Insert default permission mappings
   - Create indexes for performance

2. **Backend: Role Detection**
   - Implement `getUserRole` resolver
   - Implement `getUserPermissions` resolver
   - Add helper function to check Jira project roles
   - Add helper function to check custom role mappings

3. **Backend: Permission Checks**
   - Add permission validation to existing resolvers
   - Return appropriate error messages for unauthorized access
   - Log access attempts for audit trail

### Phase 2: Data Filtering (Week 2)

1. **Time Analytics Filtering**
   - Modify `getTimeAnalytics` to filter by role
   - Admin: All data
   - Project Manager: Team data in assigned projects
   - Developer: Own data only
   - Viewer: Own data (read-only)

2. **Screenshot Filtering**
   - Modify `getScreenshots` to filter by role
   - Add project-based filtering
   - Add user-based filtering

3. **BRD Document Filtering**
   - Modify BRD-related resolvers
   - Filter documents by project and user

### Phase 3: UI Updates (Week 3)

1. **Role State Management**
   - Add role state to React app
   - Fetch role on component mount
   - Cache role in component state

2. **Conditional Rendering**
   - Hide/show tabs based on role
   - Hide/show buttons based on permissions
   - Show appropriate data views

3. **User Feedback**
   - Show role badge in header
   - Display permission messages
   - Show "Access Denied" messages

### Phase 4: Admin Interface (Week 4)

1. **Role Management UI** (Admin only)
   - Create role assignment interface
   - Allow admins to assign roles to users
   - Show current role assignments

2. **Permission Configuration** (Admin only)
   - Allow admins to customize permissions
   - Override default permission matrix
   - Save custom permissions

---

## 5. Security Considerations

### 5.1 Backend Validation
- **Always validate permissions on the backend** - Never trust frontend checks alone
- Use resolver-level permission checks
- Return appropriate error codes (403 Forbidden)

### 5.2 Data Isolation
- Use Row-Level Security (RLS) in Supabase
- Filter queries by user_id and project_key
- Prevent cross-user data access

### 5.3 Audit Logging
- Log all permission checks
- Log access attempts (successful and failed)
- Store audit logs in Supabase

### 5.4 Error Handling
- Don't expose sensitive information in error messages
- Use generic "Access Denied" messages for unauthorized access
- Log detailed errors server-side only

---

## 6. Testing Strategy

### 6.1 Unit Tests
- Test role detection logic
- Test permission checks
- Test data filtering functions

### 6.2 Integration Tests
- Test resolver functions with different roles
- Test UI rendering with different roles
- Test data access restrictions

### 6.3 Manual Testing Checklist
- [ ] Admin can access all features
- [ ] Project Manager can view team data
- [ ] Developer can only view own data
- [ ] Viewer has read-only access
- [ ] Unauthorized actions show proper errors
- [ ] UI correctly hides/shows based on role
- [ ] Data filtering works correctly

---

## 7. Migration Plan

### 7.1 Existing Users
- Default all existing users to "Developer" role
- Allow admins to upgrade users to appropriate roles
- No data loss during migration

### 7.2 Backward Compatibility
- Maintain existing resolvers with default behavior
- Add role checks as additional layer
- Gracefully handle missing role data

---

## 8. Future Enhancements

### 8.1 Advanced Features
- Project-specific role assignments
- Time-based role assignments (temporary access)
- Role inheritance (team lead inherits developer permissions)
- Custom permission sets

### 8.2 Integration
- Sync roles from Jira groups
- Auto-assign roles based on Jira project roles
- Integration with Jira Service Management roles

---

## 9. Documentation Updates

### 9.1 User Documentation
- Create user guide for each role
- Document permission differences
- Create FAQ for access issues

### 9.2 Developer Documentation
- Document role system architecture
- Document permission checking patterns
- Create examples for adding new permissions

---

## 10. Rollout Plan

### 10.1 Beta Release
- Deploy to test environment
- Test with sample users from each role
- Gather feedback

### 10.2 Production Release
- Deploy to production
- Monitor for errors
- Provide support for role assignment

### 10.3 Post-Release
- Monitor access patterns
- Adjust permissions based on feedback
- Optimize performance

---

## Questions to Resolve Before Implementation

1. **Role Assignment**: Who can assign roles? (Admin only? Project Manager for their projects?)
2. **Default Role**: What should be the default role for new users? (Developer recommended)
3. **Project Context**: Should roles be project-specific or global?
4. **Role Hierarchy**: Should there be role inheritance? (e.g., Admin > Project Manager > Developer > Viewer)
5. **Custom Roles**: Should we support custom role definitions or stick to predefined roles?

---

## Next Steps

1. Review and approve this plan
2. Resolve questions above
3. Create database migration scripts
4. Implement backend role detection
5. Implement permission checks
6. Update frontend components
7. Test thoroughly
8. Deploy to production

---

## Appendix: Code Structure

```
forge-app/
├── src/
│   ├── index.js                    # Resolvers (add role checks)
│   ├── utils/
│   │   ├── role-detection.js       # NEW: Role detection logic
│   │   └── permissions.js           # NEW: Permission checking
│   └── ...
├── static/
│   ├── main/
│   │   └── src/
│   │       ├── App.js              # Add role state
│   │       ├── components/
│   │       │   ├── RoleBasedWrapper.js  # NEW: Conditional rendering
│   │       │   └── RoleBadge.js         # NEW: Display user role
│   │       └── ...
│   └── settings/
│       └── src/
│           └── components/
│               └── RoleManagement.js    # NEW: Admin role management
└── ...

supabase/
└── migrations/
    ├── 006_user_roles.sql          # NEW: Role tables
    └── 007_role_permissions.sql     # NEW: Permission mappings
```

---

**Document Version**: 1.0  
**Last Updated**: 2025-11-18  
**Status**: Draft - Awaiting Approval

