# ⚠️ App-Specific Data Deletion - User Guide

**Issue Identified:** April 8, 2026  
**Question:** How can users delete data from ONLY our app (not all Atlassian apps)?

---

## The Problem

Atlassian's Personal Data Reporting API **does not support per-app deletion requests.**

When a user submits a data deletion request via Atlassian Support:
- ❌ They **CANNOT** choose which apps to delete from
- ✅ Atlassian automatically deletes from **ALL installed marketplace apps**
- ❌ There is **NO way** to delete from just one app via this process

---

## Why This Happens

### Technical Limitation

When Atlassian polls apps for a personal data request, your app receives:

```javascript
{
  accountId: "user's account ID",
  cloudId: "jira instance ID", 
  requestType: "delete"
  // ❌ NO app identifier
  // ❌ NO selective deletion flag
}
```

There is **no parameter** indicating which app the request is for.

### By Design

This aligns with GDPR's **"Right to be Forgotten"** philosophy:
- Users typically want ALL their data erased from ALL services
- Not selective, per-vendor deletion

---

## Solutions for Users

### Option 1: Contact Us Directly (App-Specific Deletion) ✅

**When to use:** User wants to delete data ONLY from Time Tracker

**Process:**
1. User emails: **privacy@jiraforge.com** (or support email)
2. Includes:
   - Atlassian account email
   - Jira site URL
   - Request: "Delete my Time Tracker data only"
3. We manually delete their data within **30 days**
4. We send written confirmation

**Advantage:** Other apps' data is NOT affected

---

### Option 2: Uninstall the App (App-Specific Deletion) ✅

**When to use:** User no longer needs Time Tracker

**Process:**
1. User (admin) goes to: **Jira → Settings → Apps → Manage apps**
2. Finds **"Time Tracker"** in the list
3. Clicks **Uninstall**
4. Confirms uninstall

**What happens:**
- App is removed from Jira
- 30-day grace period begins
- After 30 days: **All organization data permanently deleted**
- Includes ALL users in that organization

**Advantage:** 
- Automated deletion
- Reinstalling within 30 days recovers data

---

### Option 3: Atlassian Support (ALL Apps Deletion) ⚠️

**When to use:** User wants to delete from ALL marketplace apps

** Process:**
1. User submits ticket: https://support.atlassian.com/contact/
2. Selects: **"Personal data and GDPR"** → **"Request to delete personal data"**
3. Atlassian Support processes request
4. **ALL installed marketplace apps delete the user's data**

**Warning:** This affects:
- Jira (Atlassian's data)
- Confluence (if installed)
- Trello (if linked)
- **Time Tracker** (your app)
- **ALL other marketplace apps**

**Cannot undo** after processing completes.

---

## Privacy Policy Language

### Recommended Section

```markdown
## How to Delete Your Personal Data

### Option 1: Delete from Time Tracker Only

To delete your data **only from Time Tracker** (without affecting other apps):

**Email:** privacy@jiraforge.com  
**Subject:** Data Deletion Request - Time Tracker Only  
**Include:**
- Your Atlassian account email
- Your Jira site URL (e.g., yourcompany.atlassian.net)

We will permanently delete your data within 30 days and send confirmation.

---

### Option 2: Delete from ALL Marketplace Apps

To delete your data from **all Atlassian Marketplace apps** (including Time Tracker):

1. Go to: https://support.atlassian.com/contact/
2. Select: **"Personal data and GDPR"**
3. Select: **"Request to delete personal data"**
4. Submit the request

⚠️ **Warning:** This will delete your data from:
- Time Tracker (our app)
- All other installed marketplace apps
- Possibly some Atlassian-hosted data

This action **cannot be undone**.

---

### Option 3: Uninstall Time Tracker

Your organization admin can uninstall Time Tracker from Jira:

1. Go to: **Jira → Settings → Apps → Manage apps**
2. Find **"Time Tracker"**
3. Click **Uninstall**

All organization data (including all users) will be deleted after a 30-day grace period.

**Note:** Reinstalling within 30 days will recover your data.
```

---

## Support Team Guidelines

### When users contact support asking to delete data:

**Question 1:** "Do you want to delete from Time Tracker only, or from all apps?"

| Answer | Action |
|--------|--------|
| "Time Tracker only" | **Process manual deletion** (Option 1) |
| "All apps" | **Direct to Atlassian Support** (Option 3) |
| "Not sure" | **Explain options**, let user decide |

**Question 2:** "Are you the organization admin?"

| Answer | Deletion Scope |
|--------|----------------|
| Yes | Can delete **entire organization** (all users) |
| No | Can request deletion of **their data only** |

**Question 3:** "Do you still use other Atlassian Marketplace apps?"

| Answer | Recommendation |
|--------|----------------|
| Yes | **Option 1** (email us) or **Option 2** (uninstall) |
| No | **Option 3** (Atlassian Support - deletes all) is fine |

###Manual Deletion Process (Option 1):

1. **Verify identity:**
   - Email domain matches Jira site
   - Or request additional verification

2. **Log the request:**
   - Create support ticket
   - Document: date, user email, Jira site URL

3. **Execute deletion:**
   - Use admin endpoint or manual SQL (with proper authorization)
   - Delete from `data_requests` table if exists
   - Verify deletion completed

4. **Confirm to user:**
   - Email template: "Your Time Tracker data has been permanently deleted"
   - Include: deletion date, what was deleted, confirmation number

5. **Retention:**
   - Keep anonymized audit log (required for compliance)
   - Do NOT keep any personal data

---

## Testing Scenarios

### Scenario 1: User wants to delete from Time Tracker only

**User action:** Emails privacy@jiraforge.com  
**Expected:** Manual deletion, other apps unaffected  
**Test:** User still has data in other marketplace apps after deletion

---

### Scenario 2: User submits Atlassian Support ticket

**User action:** Uses https://support.atlassian.com/contact/ → "Request to delete personal data"  
**Expected:** Your app's `userDataProvider` API is called, returns COMPLETED  
**Test:** Verify data is deleted from your database

---

### Scenario 3: Admin uninstalls app

**User action:** Admin goes to Jira → Settings → Apps → Uninstall Time Tracker  
**Expected:** Lifecycle handler triggered, organization marked for deletion  
**Test:** After 30 days, all organization data is gone

---

## FAQ

### Q: Can users choose which apps to delete from via Atlassian Support?

**A:** No. Atlassian Support's data deletion request affects ALL installed marketplace apps. There is no selective, per-app option.

---

### Q: What if a user wants to keep data in App A but delete from App B?

**A:** They must contact each app vendor directly (not Atlassian Support). Each app should provide a direct deletion process (like our Option 1).

---

### Q: Why doesn't Atlassian let users choose which apps?

**A:** GDPR's "Right to be Forgotten" typically means deleting from ALL data controllers (not selective deletion). Atlassian implements this as "delete everywhere."

---

### Q: What if we want to let users delete via our own UI?

**A:** You can build this! Options:
1. Add "Delete my data" button in Forge app settings
2. Create self-service web portal
3. Require email verification before deletion

This is **in addition to** (not instead of) the Atlassian Personal Data Reporting API.

---

## Implementation Status

| Feature | Status | Notes |
|---------|--------|-------|
| **Atlassian Support deletion** | ✅ Implemented | Via `userDataProvider` API |
| **App uninstall deletion** | ✅ Implemented | 30-day grace period |
| **Direct email deletion** | ⚠️ **Manual process** | Support team handles |
| **Self-service deletion UI** | ❌ Not implemented | Future enhancement |

---

## Recommendations

### For Privacy Policy:

✅ **Do:** Explain all three deletion options clearly  
✅ **Do:** Warn that Atlassian Support = ALL apps deletion  
✅ **Do:** Provide direct contact email for app-specific deletion  
❌ **Don't:** Claim users can delete from "just your app" via Atlassian Support

---

### For Support Team:

✅ **Do:** Train team on three deletion paths  
✅ **Do:** Create email templates for manual deletion  
✅ **Do:** Log all manual deletion requests  
❌ **Don't:** Direct users to Atlassian Support if they only want to delete from your app

---

### For Future Development:

💡 **Consider building:** Self-service deletion UI in Forge app  
💡 **Consider building:** Web portal for data requests  
💡 **Consider building:** Automated deletion request system (with verification)

---

**Document Status:** ✅ Verified against Atlassian API and GDPR requirements  
**Last Updated:** April 8, 2026  
**Owner:** Privacy & Compliance Team
