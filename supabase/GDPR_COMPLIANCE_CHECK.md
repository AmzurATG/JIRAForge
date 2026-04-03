# GDPR Compliance Check

**Run this monthly to ensure all user data tables are tracked in the Personal Data Reporting API.**

## Quick Check

```sql
-- Copy and paste into Supabase SQL Editor
\i check_gdpr_compliance.sql
```

OR run individual parts:

```sql
-- Part 1: Check for untracked tables with user_id
SELECT table_name, column_name
FROM information_schema.columns
WHERE column_name = 'user_id'
  AND table_schema = 'public'
ORDER BY table_name;
```

**Expected Result (as of April 2026):** 16 tables

If you see NEW tables not in this list, you MUST:
1. Update `ai-server/src/services/user-data-service.js`
2. Add export query in `exportUserData()`
3. Add deletion query in `deleteUserData()`
4. Test thoroughly
5. Update documentation

## Documentation

See: [docs/QUICK_REFERENCE_NEW_TABLES.md](../docs/QUICK_REFERENCE_NEW_TABLES.md)

## Full Audit Script

Location: `check_gdpr_compliance.sql`

This script checks:
- ✅ Untracked tables with user_id
- ✅ New storage buckets
- ✅ Row counts per table
- ✅ Tables with PII columns (email, name, etc.)
- ✅ Foreign key relationships
- ✅ CASCADE delete configuration

**Set a monthly calendar reminder to run this!**

---

## Current Tracked Tables (April 2026)

1. users
2. organization_members
3. screenshots
4. analysis_results
5. activity_records
6. worklogs
7. documents
8. feedback
9. tracking_settings
10. notification_preferences
11. activity_log
12. user_jira_issues_cache
13. unassigned_activity
14. worklog_sync
15. notification_logs
16. notification_cooldowns

**Total: 16 tables**

## Current Tracked Buckets

1. screenshots
2. documents
3. feedback-images
4. exports (temporary, auto-cleanup)

**Total: 4 buckets (3 with user data)**

---

**Last Audit:** [Add date when you run the check]  
**Next Audit Due:** [Add date 1 month from now]
