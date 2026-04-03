# App Uninstall Data Deletion - FAQ

## Why Manual Updates Are Needed (Technical Explanation)

### TL;DR
**Almost everything is automatic!** Only **Forge KVS cache keys** need manual updates due to API limitations.

---

## Detailed Breakdown

### ✅ Fully Automatic (No Code Changes Needed)

#### 1. **Database Tables**
**How it works:**
```sql
-- PostgreSQL information_schema lets us query for tables with organization_id
SELECT table_name 
FROM information_schema.columns 
WHERE column_name = 'organization_id';
```

**What you do:**
- Add new table with `organization_id UUID REFERENCES organizations(id)` column
- **That's it!** Deletion service automatically discovers and deletes it

**Example:**
```sql
CREATE TABLE new_feature_data (
    id UUID PRIMARY KEY,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,  -- ✅ Auto-discovered!
    data JSONB
);
```

---

#### 2. **Materialized Views**
**How it works:**
```sql
-- Query PostgreSQL catalog to find materialized views with organization_id
SELECT matviewname 
FROM pg_matviews 
WHERE EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = matviewname AND column_name = 'organization_id'
);
```

**What you do:**
- Create materialized view with `organization_id` column
- **That's it!** Deletion service automatically refreshes or drops it

---

#### 3. **Storage Buckets**
**How it works:**
```javascript
// Supabase Storage API can list all buckets
const { data: buckets } = await supabase.storage.listBuckets();

// Then for each bucket, try org-scoped and user-scoped deletion
// Pattern 1: {organizationId}/file.png
// Pattern 2: {userId}/file.png
```

**What you do:**
- Create new storage bucket
- Use standard folder structure: `{organizationId}/...` or `{userId}/...`
- **That's it!** Deletion service automatically discovers and cleans bucket

**Example:**
```javascript
// New bucket: 'reports'
// Structure: reports/{organizationId}/monthly-report.pdf
// ✅ Auto-discovered and cleaned!
```

---

#### 4. **Regular Database Views**
**How it works:**
- Views are just saved SQL queries - they don't store data
- After org deletion, views automatically return empty results for that org
- **No cleanup needed!**

---

### ⚠️ Semi-Automatic (Works with Naming Convention)

#### 5. **Custom Storage Patterns**
**When automatic:**
- If you use `{organizationId}/` or `{userId}/` folder structure

**When manual update needed:**
- Custom folder structure like `{projectKey}/{organizationId}/file.png`
- Then update `deleteStorageFiles()` function

---

### ❌ Requires Manual Update

#### 6. **Forge KVS (Key-Value Storage)**

**Why manual?**
```javascript
// ❌ Forge KVS API limitations:
// - No kvs.listKeys() function
// - No kvs.enumerate() function
// - No kvs.keys() function
// - Can only get specific key: kvs.get('exact-key-name')

// You CANNOT do this:
const allKeys = await kvs.listKeys();  // ❌ Doesn't exist!

// You CAN only do this:
const value = await kvs.get('analytics:perms:12345');  // ✅ If you know the key
```

**What you do:**
```javascript
// In clearSiteCache() function, manually add your key pattern:
const keysToDelete = [
  `org:${cloudId}`,
  `analytics:perms:*`,  // ❌ Can't use wildcards!
  `your-new-cache:${cloudId}`  // ✅ Add manually
];
```

**Why Forge doesn't allow key enumeration:**
- Security: Prevents apps from scanning all storage
- Performance: KVS is distributed, listing all keys would be expensive
- Design: Forge KVS is designed for known-key access only

---

#### 7. **External Services**
**Why manual?**
- Data stored outside Supabase (AWS S3, Redis, third-party APIs)
- No API to auto-discover what's there
- Each service has different APIs

**Example:**
```javascript
// If you also store data in AWS S3 (separate from Supabase):
async function deleteExternalData(orgId) {
  await s3.deleteObjects({
    Bucket: 'my-bucket',
    Delete: { Objects: [{ Key: `${orgId}/data.json` }] }
  });
}
```

---

## Comparison Table

| Data Type | Auto-Discovered? | API Support | Manual Update Needed |
|-----------|------------------|-------------|----------------------|
| **Tables** | ✅ YES | `information_schema.columns` | ❌ No |
| **Materialized Views** | ✅ YES | `pg_matviews` catalog | ❌ No |
| **Storage Buckets** | ✅ YES | `supabase.storage.listBuckets()` | ❌ No (if using standard folders) |
| **Regular Views** | ✅ N/A | Not needed (views don't store data) | ❌ No |
| **Forge KVS** | ❌ NO | No enumeration API | ✅ Yes |
| **External Services** | ❌ NO | Service-specific | ✅ Yes |

---

## Real-World Examples

### Example 1: Adding a New Feature Table ✅ Automatic

```sql
-- You add this table:
CREATE TABLE time_approvals (
    id UUID PRIMARY KEY,
    organization_id UUID REFERENCES organizations(id),  -- ✅ Key column
    user_id UUID,
    approved_hours INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deletion service automatically does:
-- 1. SELECT table_name FROM information_schema.columns 
--    WHERE column_name = 'organization_id'
-- 2. Finds 'time_approvals' table
-- 3. DELETE FROM time_approvals WHERE organization_id = 'deleted-org-id'
-- ✅ No code changes needed!
```

---

### Example 2: Adding a New Storage Bucket ✅ Automatic

```javascript
// You create a new bucket for invoices
await supabase.storage.createBucket('invoices');

// You upload files with org-scoped structure:
await supabase.storage
  .from('invoices')
  .upload(`${organizationId}/invoice-2026-01.pdf`, file);

// Deletion service automatically does:
// 1. const { data: buckets } = await supabase.storage.listBuckets()
// 2. Finds 'invoices' bucket
// 3. Lists files under `${organizationId}/`
// 4. Deletes all files
// ✅ No code changes needed!
```

---

### Example 3: Adding a New KVS Cache ❌ Manual

```javascript
// You add new caching for reports:
await kvs.set(`reports:${cloudId}`, reportData);

// ❌ Deletion service CANNOT auto-discover this
// ❌ No API to list all keys

// ✅ You must manually update clearSiteCache():
async function clearSiteCache(cloudId) {
  const keysToDelete = [
    `org:${cloudId}`,
    `analytics:perms:${cloudId}`,
    `reports:${cloudId}`  // ✅ Add your new key pattern
  ];
  
  for (const key of keysToDelete) {
    await kvs.delete(key);
  }
}
```

---

### Example 4: Adding a Materialized View ✅ Automatic

```sql
-- You create a materialized view for reporting:
CREATE MATERIALIZED VIEW org_daily_stats AS
SELECT 
    organization_id,  -- ✅ Key column
    DATE(created_at) AS date,
    COUNT(*) AS screenshot_count
FROM screenshots
GROUP BY organization_id, DATE(created_at);

-- Deletion service automatically does:
-- 1. SELECT matviewname FROM pg_matviews WHERE has organization_id column
-- 2. Finds 'org_daily_stats'
-- 3. REFRESH MATERIALIZED VIEW org_daily_stats
-- ✅ No code changes needed!
```

---

## Summary: What Needs Manual Updates?

### Only 2 Cases:

1. **Forge KVS cache keys** - API limitation, no enumeration
2. **External services** - Data outside Supabase, service-specific

### Everything Else is Automatic! 🎉

- Tables with `organization_id`: ✅ Auto-discovered via PostgreSQL schema
- Storage buckets: ✅ Auto-discovered via Supabase Storage API  
- Materialized views: ✅ Auto-discovered via PostgreSQL catalog
- Regular views: ✅ Don't need cleanup (no data stored)

---

## Future-Proof Checklist

When adding a new feature:

```
[ ] Does it use a database table?
    └─ [ ] Yes → Add organization_id column → ✅ Auto-deleted!
    └─ [ ] No → Continue...

[ ] Does it use storage buckets?
    └─ [ ] Yes → Use {orgId}/ or {userId}/ folder structure → ✅ Auto-deleted!
    └─ [ ] Custom structure → Update deleteStorageFiles()

[ ] Does it use Forge KVS cache?
    └─ [ ] Yes → Update clearSiteCache() with new key pattern

[ ] Does it use external service (not Supabase)?
    └─ [ ] Yes → Add cleanup logic for that service

[ ] Does it use materialized view?
    └─ [ ] Yes → Include organization_id column → ✅ Auto-refreshed!

[ ] Does it use regular view?
    └─ [ ] Yes → No action needed → ✅ Auto-handled!
```

---

## Questions?

**Q: Can we make Forge KVS automatic too?**
A: Unfortunately no - this is a Forge platform limitation, not our code. Atlassian Forge doesn't provide any API to list or enumerate keys. This is by design for security/performance reasons.

**Q: What if I add a table without organization_id?**
A: The automatic discovery looks for the `organization_id` column. If your table doesn't have it, it won't be auto-discovered. Make sure all org-scoped tables include this column!

**Q: What if I use cloudId instead of organization_id?**
A: The auto-discovery specifically looks for `organization_id`. If you use a different column name, you'll need to:
- Option 1: Add `organization_id` column (recommended)
- Option 2: Update the `get_org_scoped_tables()` function to look for your column name

**Q: How do I verify automatic discovery is working?**
A: Run this query after adding your table:
```sql
SELECT * FROM get_org_scoped_tables();
-- Your new table should appear in the list!
```

---

Last Updated: April 3, 2026
