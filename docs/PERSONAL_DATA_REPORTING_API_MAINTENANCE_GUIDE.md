# Personal Data Reporting API - Maintenance Guide

**Critical:** This guide MUST be followed when adding new tables or storage buckets that contain user personal data.

---

## 🚨 Critical Compliance Requirement

**When you add ANY new database table or storage bucket that contains user personal data, you MUST update the Personal Data Reporting API implementation.**

Failure to do so means:
- ❌ User data export will be **incomplete** (GDPR Article 20 violation)
- ❌ User data deletion will be **incomplete** (GDPR Article 17 violation)
- ❌ App may be **de-listed** from Atlassian Marketplace
- ❌ Legal liability for GDPR non-compliance

---

## What Qualifies as "User Personal Data"?

A table or storage bucket contains user personal data if it has:
- `user_id` column (directly linked to a user)
- User-identifiable information (email, name, IP address, etc.)
- User-generated content (screenshots, documents, feedback)
- User behavior data (activity logs, tracking data)

**Examples of personal data:**
- ✅ Screenshots
- ✅ Activity tracking records
- ✅ Email addresses
- ✅ Feedback/comments
- ✅ Uploaded files
- ✅ Login history
- ✅ IP addresses

**Examples of NOT personal data:**
- ❌ Organization settings (if not user-specific)
- ❌ App configuration
- ❌ System logs without user identifiers
- ❌ Aggregated analytics

---

## Maintenance Checklist

### When Adding a New Table with User Data

**Step 1: Database Schema**

- [ ] Ensure table has `user_id UUID REFERENCES users(id) ON DELETE CASCADE`
- [ ] Add RLS (Row Level Security) policies
- [ ] Test CASCADE delete works correctly

**Step 2: Update Export Function**

File: `ai-server/src/services/user-data-service.js`

- [ ] Add query in `exportUserData()` function:
  ```javascript
  // X. New table name
  const { data: newTableRecords } = await supabase
    .from('new_table_name')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10000); // Adjust limit based on expected volume

  exportData.newTableRecords = newTableRecords || [];
  exportData.newTableRecordCount = newTableRecords?.length || 0;
  ```
- [ ] Add to export data structure
- [ ] Update table count in function header comment

**Step 3: Update Deletion Function**

File: `ai-server/src/services/user-data-service.js`

- [ ] Determine deletion order (child tables before parent tables)
- [ ] Add deletion query in `deleteUserData()` function:
  ```javascript
  // Delete new_table_name
  const { count: newTableCount } = await supabase
    .from('new_table_name')
    .delete({ count: 'exact' })
    .eq('user_id', userId);
  deletionSummary.recordsDeleted.new_table_name = newTableCount || 0;
  ```
- [ ] Update deletion order in function header comment
- [ ] Update table count in function header comment

**Step 4: Test Export**

- [ ] Create test user with data in new table
- [ ] Trigger export request
- [ ] Verify new table data is included in JSON export
- [ ] Verify record count is accurate
- [ ] Check export structure matches schema

**Step 5: Test Deletion**

- [ ] Create test user with data in new table
- [ ] Trigger deletion request
- [ ] Query database - verify all records deleted:
  ```sql
  SELECT * FROM new_table_name WHERE user_id = 'deleted-user-id';
  -- Should return 0 rows
  ```
- [ ] Verify deletion summary includes correct count
- [ ] Verify CASCADE didn't leave orphaned records

**Step 6: Update Documentation**

- [ ] Update `docs/PERSONAL_DATA_REPORTING_API_README.md` - Data Coverage section
- [ ] Update `docs/PERSONAL_DATA_REPORTING_API_IMPLEMENTATION_PLAN.md` - Data Inventory section
- [ ] Update Privacy Policy if new data type is significant
- [ ] Update this maintenance guide with new table in Current Tables list

**Step 7: Deploy & Verify**

- [ ] Deploy to development environment
- [ ] Run end-to-end test (export + deletion)
- [ ] Deploy to production
- [ ] Monitor first few requests for new table data

---

### When Adding a New Storage Bucket with User Data

**Step 1: Storage Setup**

- [ ] Create bucket in Supabase
- [ ] Set appropriate file size limit
- [ ] Set allowed MIME types
- [ ] Configure RLS policies (service role access)
- [ ] Document bucket path structure

**Step 2: Update Storage Export**

File: `ai-server/src/services/user-data-service.js`

- [ ] Add bucket export in `exportStorageFiles()` function:
  ```javascript
  // New bucket
  const newBucketPath = organizationId ? `${organizationId}/${userId}` : userId;
  const { data: newBucketFiles } = await supabase.storage
    .from('new-bucket-name')
    .list(newBucketPath, { limit: 10000 });

  if (newBucketFiles && newBucketFiles.length > 0) {
    for (const file of newBucketFiles) {
      const fullPath = `${newBucketPath}/${file.name}`;
      const { data: signedUrl } = await supabase.storage
        .from('new-bucket-name')
        .createSignedUrl(fullPath, 86400); // 24hr expiry

      summary.newBucketFiles.push({
        path: fullPath,
        name: file.name,
        sizeBytes: file.metadata?.size || 0,
        url: signedUrl?.signedUrl
      });
      summary.totalStorageMB += (file.metadata?.size || 0) / 1024 / 1024;
    }
    summary.totalNewBucketFiles += newBucketFiles.length;
  }

  summary.totalFiles = summary.totalScreenshots + summary.totalDocuments + 
                        summary.totalFeedbackImages + summary.totalNewBucketFiles;
  ```

**Step 3: Update Storage Deletion**

File: `ai-server/src/services/user-data-service.js`

- [ ] Add bucket deletion in `deleteStorageFiles()` function:
  ```javascript
  // New bucket
  const newBucketPaths = [];
  if (organizationId) {
    newBucketPaths.push(`${organizationId}/${userId}`);
  }
  newBucketPaths.push(userId); // Legacy path

  for (const basePath of newBucketPaths) {
    const { data: newBucketFiles } = await supabase.storage
      .from('new-bucket-name')
      .list(basePath, { limit: 10000 });

    if (newBucketFiles && newBucketFiles.length > 0) {
      const filePaths = newBucketFiles.map(f => `${basePath}/${f.name}`);
      const { error } = await supabase.storage
        .from('new-bucket-name')
        .remove(filePaths);
      
      if (!error) {
        totalDeleted += filePaths.length;
        logger.info('[UserData] Deleted new-bucket files:', { count: filePaths.length, basePath });
      } else {
        logger.error('[UserData] Error deleting new-bucket files:', error);
      }
    }
  }
  ```

**Step 4: Test & Document**

- [ ] Test export includes signed URLs for new bucket files
- [ ] Test deletion removes all files from new bucket
- [ ] Update documentation
- [ ] Update function header comments

---

## Current Tables & Buckets (April 2026)

### Database Tables (16)

| Table | Contains | Export? | Delete? |
|---|---|---|---|
| users | Core user data | ✅ | ✅ Hard delete |
| organization_members | Org membership | ✅ | ✅ Hard delete |
| screenshots | Screenshot metadata | ✅ | ✅ Hard delete |
| analysis_results | AI analysis data | ✅ | ✅ Hard delete |
| activity_records | Activity tracking | ✅ | ✅ Hard delete |
| worklogs | Jira worklog mappings | ✅ | ✅ Hard delete |
| documents | BRD document metadata | ✅ | ✅ Hard delete |
| feedback | User feedback | ✅ | ✅ Hard delete |
| tracking_settings | User preferences | ✅ | ✅ Hard delete |
| notification_preferences | Notification settings | ✅ | ✅ Hard delete |
| activity_log | Audit trail | ✅ | ⚠️ Anonymize only |
| user_jira_issues_cache | Cached issues | ✅ | ✅ Hard delete |
| unassigned_activity | Unassigned work | ✅ | ✅ Hard delete |
| worklog_sync | Sync state | ✅ | ✅ Hard delete |
| notification_logs | Email history | ✅ | ✅ Hard delete |
| notification_cooldowns | Spam prevention | ✅ | ✅ Hard delete |

### Storage Buckets (3)

| Bucket | Path Pattern | Export? | Delete? |
|---|---|---|---|
| screenshots | `{org_id}/{user_id}/*.png` | ✅ Signed URLs | ✅ All files |
| documents | `{org_id}/{user_id}/*.pdf` | ✅ Signed URLs | ✅ All files |
| feedback-images | `{user_id}/*.png` | ✅ Signed URLs | ✅ All files |

---

## Common Mistakes to Avoid

### ❌ Forgetting Deletion Order

**Wrong:**
```javascript
// This will fail due to FK constraint
DELETE FROM screenshots WHERE user_id = userId;
DELETE FROM analysis_results WHERE user_id = userId; // FK to screenshots!
```

**Correct:**
```javascript
// Delete child records first
DELETE FROM analysis_results WHERE user_id = userId; // Child
DELETE FROM screenshots WHERE user_id = userId;      // Parent
```

### ❌ Soft Delete Instead of Hard Delete

**Wrong:**
```javascript
// GDPR requires PERMANENT deletion
UPDATE users SET deleted_at = NOW() WHERE id = userId;
```

**Correct:**
```javascript
// Hard delete (permanent)
DELETE FROM users WHERE id = userId;
```

### ❌ Forgetting Storage Files

**Wrong:**
```javascript
// Only deleting database records, files remain in storage
DELETE FROM documents WHERE user_id = userId;
```

**Correct:**
```javascript
// Delete files from storage FIRST, then database records
await deleteStorageFiles(userId, organizationId);
DELETE FROM documents WHERE user_id = userId;
```

### ❌ Missing Existing Paths

**Wrong:**
```javascript
// Only checking org-scoped path
const path = `${organizationId}/${userId}`;
await supabase.storage.from('screenshots').list(path);
```

**Correct:**
```javascript
// Check both org-scoped and legacy user-only paths
const paths = [];
if (organizationId) paths.push(`${organizationId}/${userId}`);
paths.push(userId); // Legacy path

for (const path of paths) {
  await supabase.storage.from('screenshots').list(path);
}
```

---

## Testing New Tables/Buckets

### Test Script Template

```javascript
// test-new-table-gdpr.js
const { exportUserData, deleteUserData } = require('./ai-server/src/services/user-data-service');

async function testNewTableGDPR() {
  const testAccountId = 'test-account-123';
  const testCloudId = 'cloud-test';
  
  console.log('Step 1: Create test data in new table...');
  // Insert test data into new_table_name
  
  console.log('Step 2: Test export...');
  const exportData = await exportUserData(testAccountId, testCloudId);
  
  // Verify export includes new table
  if (!exportData.newTableRecords) {
    throw new Error('❌ Export missing new table data!');
  }
  console.log(`✅ Export includes ${exportData.newTableRecordCount} records from new table`);
  
  console.log('Step 3: Test deletion...');
  const deletionSummary = await deleteUserData(testAccountId, testCloudId);
  
  // Verify deletion summary includes new table
  if (deletionSummary.recordsDeleted.new_table_name === undefined) {
    throw new Error('❌ Deletion summary missing new table!');
  }
  console.log(`✅ Deleted ${deletionSummary.recordsDeleted.new_table_name} records from new table`);
  
  console.log('Step 4: Verify data is gone...');
  // Query new_table_name for test user - should return 0 rows
  
  console.log('✅ All tests passed!');
}

testNewTableGDPR().catch(console.error);
```

---

## Monitoring

### Query to Find Untracked Tables

```sql
-- Find all tables with user_id column that might be untracked
SELECT 
  table_name,
  column_name
FROM information_schema.columns
WHERE column_name = 'user_id'
  AND table_schema = 'public'
  AND table_name NOT IN (
    'users',
    'organization_members',
    'screenshots',
    'analysis_results',
    'activity_records',
    'worklogs',
    'documents',
    'feedback',
    'tracking_settings',
    'notification_preferences',
    'activity_log',
    'user_jira_issues_cache',
    'unassigned_activity',
    'worklog_sync',
    'notification_logs',
    'notification_cooldowns'
  )
ORDER BY table_name;
```

**Run this query monthly to check for new tables!**

### Query to Find Untracked Buckets

```sql
-- List all storage buckets
SELECT id, name, created_at
FROM storage.buckets
WHERE name NOT IN ('screenshots', 'documents', 'feedback-images', 'exports')
ORDER BY created_at DESC;
```

---

## Rollback Procedure

If you deployed changes but forgot to update export/deletion:

**Step 1: Hotfix**
1. Update `user-data-service.js` with missing table/bucket
2. Deploy immediately
3. Test export/deletion

**Step 2: Verify**
1. Trigger export for affected users
2. Verify new table data is included
3. Document in incident log

**Step 3: Audit**
1. Check how many requests were processed with incomplete data
2. Notify affected users if needed (GDPR breach notification)
3. Re-export data for affected users

---

## Code Review Checklist

When reviewing PRs that add new tables/buckets:

- [ ] Does PR add table with `user_id` column?
- [ ] Does PR add storage bucket with user files?
- [ ] Has `user-data-service.js` been updated?
- [ ] Are export tests included?
- [ ] Are deletion tests included?
- [ ] Is documentation updated?
- [ ] Has this maintenance guide been updated?
- [ ] Is deletion order correct (child before parent)?
- [ ] Are storage files deleted before database records?

**If ANY checkbox is unchecked and table contains user data: BLOCK THE PR**

---

## Annual Audit Checklist

Perform this audit **at least once per year**:

- [ ] Run "Find Untracked Tables" query
- [ ] Run "Find Untracked Buckets" query
- [ ] Review all tables added in past 12 months
- [ ] Test export on production user (with permission)
- [ ] Test deletion on test user
- [ ] Verify Privacy Policy is up-to-date
- [ ] Review GDPR compliance status
- [ ] Update documentation with any changes

---

## Emergency Contacts

**For GDPR Compliance Issues:**
- Legal Team: [Contact info]
- Compliance Officer: [Contact info]

**For Technical Issues:**
- Lead Developer: [Contact info]
- DevOps Team: [Contact info]

**For Atlassian Marketplace:**
- Marketplace Support: marketplace@atlassian.com

---

## Version History

| Date | Version | Changes | Author |
|---|---|---|---|
| April 3, 2026 | 1.0 | Initial maintenance guide | Implementation Team |

---

## References

- [PERSONAL_DATA_REPORTING_API_README.md](./PERSONAL_DATA_REPORTING_API_README.md)
- [PERSONAL_DATA_REPORTING_API_IMPLEMENTATION_PLAN.md](./PERSONAL_DATA_REPORTING_API_IMPLEMENTATION_PLAN.md)
- [GDPR Article 17 - Right to Erasure](https://gdpr-info.eu/art-17-gdpr/)
- [GDPR Article 20 - Right to Data Portability](https://gdpr-info.eu/art-20-gdpr/)
- [Atlassian Data Privacy Guidelines](https://developer.atlassian.com/platform/marketplace/data-privacy-guidelines/)

---

**Remember: GDPR compliance is not a one-time task. It requires ongoing maintenance and vigilance.**
