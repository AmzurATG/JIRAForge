# 🚨 QUICK REFERENCE: Adding New User Data Tables

**⏱️ Time to read: 2 minutes**  
**📋 Use this checklist EVERY TIME you add a table with `user_id` column**

---

## ✅ Mandatory Checklist

When you create a new table with user personal data:

### 1. Database Schema ✅
- [ ] Table has `user_id UUID` column
- [ ] Foreign key: `REFERENCES users(id) ON DELETE CASCADE`
- [ ] RLS enabled with service role policy
- [ ] Migration file created
- [ ] Rollback script created

### 2. Update Export Function ✅
File: `ai-server/src/services/user-data-service.js`

- [ ] Add query in `exportUserData()` function (around line 240):
  ```javascript
  // X. Your new table
  const { data: newRecords } = await supabase
    .from('your_table_name')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10000);
  
  exportData.yourTableRecords = newRecords || [];
  exportData.yourTableRecordCount = newRecords?.length || 0;
  ```
- [ ] Update table count in function header comment

### 3. Update Deletion Function ✅
File: `ai-server/src/services/user-data-service.js`

- [ ] Add deletion in `deleteUserData()` function (around line 680):
  ```javascript
  // Delete your_table_name
  const { count: yourTableCount } = await supabase
    .from('your_table_name')
    .delete({ count: 'exact' })
    .eq('user_id', userId);
  deletionSummary.recordsDeleted.your_table_name = yourTableCount || 0;
  ```
- [ ] Ensure correct deletion order (child before parent!)
- [ ] Update table count in function header comment

### 4. Test ✅
- [ ] Create test user with data in new table
- [ ] Run export → verify new table data appears in JSON
- [ ] Run deletion → verify `SELECT * FROM your_table WHERE user_id = ...` returns 0 rows
- [ ] Check deletion summary includes your table count

### 5. Documentation ✅
- [ ] Update `docs/PERSONAL_DATA_REPORTING_API_README.md` (Data Coverage section)
- [ ] Update `docs/PERSONAL_DATA_REPORTING_API_IMPLEMENTATION_PLAN.md` (Data Inventory)
- [ ] Update table count: "16 tables" → "17 tables"

### 6. Deploy ✅
- [ ] Deploy to dev and test end-to-end
- [ ] Deploy to production
- [ ] Verify first export includes new data

---

## 🗂️ For New Storage Buckets

When you create a new storage bucket with user files:

### 1. Update Export Storage ✅
File: `ai-server/src/services/user-data-service.js`

Add in `exportStorageFiles()` function (around line 350):
```javascript
// Your new bucket
const yourBucketPath = organizationId ? `${organizationId}/${userId}` : userId;
const { data: yourFiles } = await supabase.storage
  .from('your-bucket-name')
  .list(yourBucketPath, { limit: 10000 });

if (yourFiles && yourFiles.length > 0) {
  for (const file of yourFiles) {
    const fullPath = `${yourBucketPath}/${file.name}`;
    const { data: signedUrl } = await supabase.storage
      .from('your-bucket-name')
      .createSignedUrl(fullPath, 86400);

    summary.yourBucketFiles.push({
      path: fullPath,
      name: file.name,
      sizeBytes: file.metadata?.size || 0,
      url: signedUrl?.signedUrl
    });
    summary.totalStorageMB += (file.metadata?.size || 0) / 1024 / 1024;
  }
  summary.totalYourBucket += yourFiles.length;
}

summary.totalFiles = summary.totalScreenshots + summary.totalDocuments + 
                      summary.totalFeedbackImages + summary.totalYourBucket;
```

### 2. Update Delete Storage ✅
File: `ai-server/src/services/user-data-service.js`

Add in `deleteStorageFiles()` function (around line 790):
```javascript
// Your bucket deletion
const yourBucketPaths = [];
if (organizationId) {
  yourBucketPaths.push(`${organizationId}/${userId}`);
}
yourBucketPaths.push(userId);

for (const basePath of yourBucketPaths) {
  const { data: yourFiles } = await supabase.storage
    .from('your-bucket-name')
    .list(basePath, { limit: 10000 });

  if (yourFiles && yourFiles.length > 0) {
    const filePaths = yourFiles.map(f => `${basePath}/${f.name}`);
    const { error } = await supabase.storage
      .from('your-bucket-name')
      .remove(filePaths);
    
    if (!error) {
      totalDeleted += filePaths.length;
      logger.info('[UserData] Deleted your-bucket files:', { count: filePaths.length });
    }
  }
}
```

---

## 🔍 Monthly Audit

Run this SQL query once per month:

```sql
-- Check for untracked tables
SELECT table_name, column_name
FROM information_schema.columns
WHERE column_name = 'user_id'
  AND table_schema = 'public'
ORDER BY table_name;
```

**Expected:** Only the 16+ tracked tables (or run `supabase/check_gdpr_compliance.sql` for full audit)

---

## 📚 Full Documentation

- **Quick Start:** This file
- **Full Checklist:** [PERSONAL_DATA_REPORTING_API_MAINTENANCE_GUIDE.md](./PERSONAL_DATA_REPORTING_API_MAINTENANCE_GUIDE.md)
- **Implementation Details:** [PERSONAL_DATA_REPORTING_API_IMPLEMENTATION_PLAN.md](./PERSONAL_DATA_REPORTING_API_IMPLEMENTATION_PLAN.md)
- **Testing:** [PERSONAL_DATA_REPORTING_API_TESTING_GUIDE.md](./PERSONAL_DATA_REPORTING_API_TESTING_GUIDE.md)

---

## ❓ Common Questions

**Q: What if I'm not sure if my table contains personal data?**  
A: If it has `user_id`, `email`, `name`, `ip_address`, or any user-generated content → it's personal data. Include it.

**Q: What if I forget to update this?**  
A: User's export will be incomplete (GDPR violation). User's deletion will be incomplete (GDPR violation). App may be de-listed.

**Q: Can I automate this?**  
A: Partially. You can auto-detect tables with `user_id`, but you still need to manually verify deletion order and test thoroughly.

**Q: How do I test this safely?**  
A: Use test users, never production users. See Testing Guide for full procedure.

**Q: Who do I contact if I have questions?**  
A: Development team lead or compliance officer.

---

## ⚠️ Remember

**GDPR compliance is not negotiable. When you add user data tables, update the export/deletion functions IMMEDIATELY.**

Don't merge a PR with new user data tables unless this checklist is complete!

---

**Last Updated:** April 3, 2026  
**Version:** 1.0
