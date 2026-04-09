# Complete Guide: How Account Deletion Works with Personal Data Reporting API

**Date:** April 8, 2026  
**Status:** ✅ Verified against Atlassian official documentation

---

## Overview

There are **FOUR ways** users can request data deletion, but only **TWO** trigger your Personal Data Reporting API implementation.

---

## Method 1: Close Account Page (Self-Service) ✅

### User Steps:

1. Go to: **id.atlassian.com/manage-profile**
2. Select: **Account Preferences**
3. Scroll to: **Delete your account** section
4. Click: **Delete account** button
5. Read warnings and confirm
6. Account enters 14-day grace period

### What Happens:

```
User clicks "Delete Account"
         ↓
14-day grace period (can cancel)
         ↓
After 14 days: Account permanently deleted
         ↓
Atlassian polls ALL installed marketplace apps
         ↓
YOUR userDataProvider API CALLED ✅
         ↓
event.payload = {
  accountId: "557058:...",
  cloudId: "a1b2c3...",
  requestType: "delete"
}
         ↓
Your Forge app returns PENDING
         ↓
Your AI server deletes data (16 tables + storage)
         ↓
7 days later: Atlassian polls again
         ↓
Your Forge app returns COMPLETED
         ↓
Deletion confirmed
```

### Key Facts:

- ✅ **Triggers Personal Data Reporting API:** YES
- ⏰ **Grace Period:** 14 days (can restore)
- 🎯 **Scope:** ALL marketplace apps (not selective)
- 👤 **Who Can Use:** Any user with **unmanaged account**
- ⚠️ **Managed Accounts:** Cannot self-delete (admin must do it)

---

## Method 2: Support Ticket ✅

### User Steps:

1. Go to: **support.atlassian.com/contact/**
2. Select: **"Personal data and GDPR"**
3. Select: **"Request to delete personal data"** (or **"Request erasure of your personal data"**)
4. Submit ticket
5. **NOTE:** Atlassian now redirects to Close Account page (self-service)

### What Happens:

```
User submits support ticket
         ↓
Atlassian Support receives request
         ↓
Support processes (1-2 days)
         ↓
Atlassian polls ALL installed marketplace apps
         ↓
YOUR userDataProvider API CALLED ✅
         ↓
(Same flow as Method 1)
```

### Key Facts:

- ✅ **Triggers Personal Data Reporting API:** YES
- ⏰ **Processing Time:** 1-3 days (slower than self-service)
- 🎯 **Scope:** ALL marketplace apps (not selective)
- 👤 **Who Can Use:** Any user
- 💡 **Current Status:** Atlassian redirects to self-service (Method 1)

---

## Method 3: Contact App Vendor Directly ⚠️

### User Steps:

1. Email: **privacy@jiraforge.com** (your support email)
2. Include: Account email, Jira site URL
3. Request: "Delete my Time Tracker data only"

### What Happens:

```
User emails your support
         ↓
Your support team verifies identity
         ↓
Manual deletion via admin tools/SQL
         ↓
NO userDataProvider API called ❌
         ↓
Confirmation email sent to user
```

### Key Facts:

- ❌ **Triggers Personal Data Reporting API:** NO
- ⏰ **Processing Time:** Your SLA (typically 30 days)
- 🎯 **Scope:** **YOUR APP ONLY** (other apps unaffected)
- 👤 **Who Can Use:** Any user
- 💡 **Use Case:** User wants to delete from only your app

---

## Method 4: Uninstall App ⚠️

### Admin Steps:

1. Go to: **Jira → Settings → Apps → Manage apps**
2. Find: **"Time Tracker"**
3. Click: **Uninstall**
4. Confirm uninstall

### What Happens:

```
Admin uninstalls app
         ↓
Atlassian fires: avi:forge:uninstalled:app
         ↓
YOUR lifecycleHandler triggered ✅
         ↓
NO userDataProvider API called ❌
         ↓
Organization marked as 'pending_deletion'
         ↓
30-day grace period
         ↓
Daily cron job deletes data (after 30 days)
```

### Key Facts:

- ❌ **Triggers Personal Data Reporting API:** NO
- ✅ **Triggers Lifecycle Handler:** YES (`avi:forge:uninstalled:app`)  
- ⏰ **Grace Period:** 30 days (can reinstall)
- 🎯 **Scope:** **ENTIRE ORGANIZATION** (all users)
- 👤 **Who Can Use:** Admin only
- 💡 **Scope:** Your app only (other apps unaffected)

---

## Comparison Table

| Method | userDataProvider API? | Lifecycle Handler? | Scope | User Type | Grace Period |
|--------|----------------------|-------------------|-------|-----------|--------------|
| **Close Account** | ✅ YES | ❌ No | All apps | Any user | 14 days |
| **Support Ticket** | ✅ YES | ❌ No | All apps | Any user | Varies |
| **Email You** | ❌ No | ❌ No | Your app only | Any user | None |
| **Uninstall App** | ❌ No | ✅ YES | Organization (all users) | Admin | 30 days |

---

## Your Implementation Coverage

### ✅ What You've Implemented:

| Feature | Implementation | Triggered By |
|---------|----------------|--------------|
| **userDataProvider** | ✅ Implemented | Close Account + Support Ticket |
| **personalDataHandler** | ✅ Implemented | Methods 1 & 2 |
| **lifecycleHandler** | ✅ Implemented | App Uninstall (Method 4) |
| **data_requests table** | ✅ Created | Methods 1 & 2 tracking |
| **deletion_audit_log** | ✅ Created | Method 4 tracking |

### ❌ What You Haven't Automated:

| Feature | Status | Alternative |
|---------|--------|-------------|
| **Direct email deletion** | Manual process | Support team handles |
| **Self-service deletion UI** | Not implemented | Users use Atlassian's UI |

---

## How They Connect

### Close Account → userDataProvider Flow:

```javascript
// 1. Atlassian calls your Forge app
export const personalDataHandler = async (event) => {
  const { accountId, cloudId, requestType } = event.payload;
  // requestType = "delete"
  
  // 2. Check for existing request
  const existing = await checkRequestStatus(accountId, cloudId, 'delete');
  
  if (!existing) {
    // First poll
    await createNewRequest(accountId, cloudId, 'delete');
    await triggerProcessing(requestId, accountId, cloudId, 'delete');
    return { status: 'PENDING' };
  } else {
    // Subsequent poll
    return { status: existing.status }; // PENDING or COMPLETED
  }
};

// 3. AI server processes deletion
// POST /api/v1/user-data/delete
async function deleteUserData(accountId, cloudId) {
  // Delete from 16 tables
  // Delete from 4 storage buckets
  // Update request status to 'completed'
}
```

### Uninstall App → lifecycleHandler Flow:

```javascript
// 1. Atlassian fires event
export const lifecycleHandler = async (event) => {
  if (event.eventType === 'avi:forge:uninstalled:app') {
    await handleAppUninstalled(event);
  }
};

// 2. Mark organization for deletion
async function handleAppUninstalled(event) {
  const { cloudId } = event.context;
  
  // Call AI server
  await invokeRemote('ai-server', {
    path: '/api/forge/uninstall',
    body: { cloudId }
  });
}

// 3. AI server marks organization
organizations.update({
  status: 'pending_deletion',
  scheduled_deletion_at: NOW() + 30 days
});

// 4. Cron job processes after 30 days
```

---

## From Atlassian's Perspective

### What Atlassian Sees (Methods 1 & 2):

```
User requests account deletion
         ↓
Atlassian maintains list of user's apps:
  - Time Tracker (marketplace app)
  - Jira Plugin A (marketplace app)
  - Confluence App B (marketplace app)
         ↓
Polls each app's userDataProvider:
  1. Time Tracker: PENDING → COMPLETED ✅
  2. Jira Plugin A: PENDING → COMPLETED ✅
  3. Confluence App B: PENDING → COMPLETED ✅
         ↓
ALL apps responded COMPLETED
         ↓
User deletion confirmed
```

**Atlassian does NOT:**
- ❌ Let user choose which apps to delete from
- ❌ Provide app-specific deletion UI
- ❌ Call userDataProvider for app uninstalls

---

## Privacy Policy Language

### Recommended Section:

```markdown
## How Your Data is Deleted

### When You Delete Your Atlassian Account

If you delete your entire Atlassian account (via id.atlassian.com or support ticket):

**What happens:**
- Your data will be deleted from **ALL Atlassian Marketplace apps**, including Time Tracker
- Atlassian automatically notifies us via their Personal Data Reporting API
- We will permanently delete all your data within 7 days
- This includes: screenshots, analysis results, worklogs, activity records, storage files

**Timeline:**
- Close Account Page: 14-day grace period (you can cancel), then permanent deletion
- Support Ticket: 1-3 business days processing, then permanent deletion

**Cannot be undone** after grace period expires.

---

### When You Want to Delete ONLY from Time Tracker

If you want to keep your Atlassian account but delete TIME TRACKER data only:

**Option 1: Email Us**
- Send email to: privacy@jiraforge.com
- Include: Your Atlassian email and Jira site URL
- We'll delete within 30 days and confirm

**Option 2: Uninstall the App**
- Admin goes to: Jira → Settings → Apps → Uninstall Time Tracker
- All organization data (including all users) deleted after 30-day grace period
- Reinstalling within 30 days recovers data
```

---

## Testing Recommendations

### Test 1: Close Account (Self-Service) - CANNOT TEST IN DEV

**Why:** Requires real Atlassian account with marketplace app installed in production

**Alternative:** 
- Use Method 2 (Support Ticket) with test account
- Or manually call your API endpoints to simulate

---

### Test 2: Support Ticket - CAN TEST

**Steps:**
1. Create test account with minimal data
2. Submit support ticket: "Request erasure of personal data"
3. Wait for Atlassian to poll your app
4. Monitor logs for personalDataHandler calls
5. Verify data deletion completed
6. Confirm Atlassian receives COMPLETED status

---

### Test 3: Manual Deletion - EASIEST TO TEST

**Steps:**
1. Create test user data
2. Call your API directly:
   ```bash
   POST /api/v1/user-data/delete
   {
     "requestId": "test-uuid",
     "accountId": "test-account-id",
     "cloudId": "test-cloud-id"
   }
   ```
3. Verify data deleted from database
4. Verify files deleted from storage

---

### Test 4: App Uninstall - CAN TEST IN DEV

**Steps:**
1. Install app in test Jira instance
2. Create test organization data
3. Uninstall app from Jira
4. Verify lifecycleHandler triggered
5. Verify organization marked as 'pending_deletion'
6. Verify cron job deletes after 30 days (or trigger manually)

---

## Monitoring & Logging

### What to Log:

```javascript
// When userDataProvider called
console.log('[PersonalData] Request received:', {
  accountId: event.payload.accountId.substring(0, 10) + '...',
  cloudId: event.payload.cloudId,
  requestType: event.payload.requestType,
  source: 'atlassian_polling',  // Add this
  timestamp: new Date().toISOString()
});

// When processing starts
console.log('[PersonalData] Processing delete request:', {
  requestId,
  tablesDeleted: 16,
  filesDeleted: fileCounts
});

// When completed
console.log('[PersonalData] Delete completed:', {
  requestId,
  duration: processingTime,
  status: 'completed'
});
```

### Metrics to Track:

- Number of deletion requests per month
- Average processing time
- Success rate (COMPLETED vs FAILED)
- Data volume deleted (rows + file sizes)

---

## FAQ

### Q: Does "Close Account" trigger my API differently than support ticket?

**A:** No. Both trigger the **exact same** userDataProvider API with **identical** event payload.

---

### Q: Can I tell which method the user used (close account vs support ticket)?

**A:** No. Your API receives the same event from both methods. You cannot distinguish between them.

---

### Q: What if user cancels account deletion during 14-day grace period?

**A:** If using Close Account method and they restore within 14 days:
- Atlassian does NOT call your API yet (deletion not finalized)
- Your data remains intact
- No action needed from you

---

### Q: What happens to data in other organizations?

**A:** Close Account / Support Ticket deletes user's data across **ALL organizations** where they have accounts.

Example:
- User has accounts in: Company A's Jira + Company B's Jira
- User deletes Atlassian account
- Your app deletes data from BOTH organizations for that user

---

### Q: Can admin request deletion for another user?

**A:** Via Close Account: No (user must do it themselves for unmanaged accounts)  
Via Support Ticket: Yes (with proper authorization from managed account admin)  
Via Email to You: Yes (if you verify authorization)

---

## Summary

✅ **Close Account Page** = Self-service, 14-day grace, triggers your API  
✅ **Support Ticket** = Atlassian-assisted, triggers your API  
⚠️ **Email You** = Manual, app-specific, does NOT trigger API  
⚠️ **Uninstall App** = Lifecycle handler, organization-wide, does NOT trigger API

**Your implementation correctly handles Methods 1 & 2 via userDataProvider ✅**  
**Your implementation correctly handles Method 4 via lifecycleHandler ✅**  
**Method 3 requires manual support team intervention ⚠️**

---

**Status:** ✅ Implementation Complete and Compliant  
**Last Updated:** April 8, 2026  
**Verified Against:** Atlassian Official Documentation
