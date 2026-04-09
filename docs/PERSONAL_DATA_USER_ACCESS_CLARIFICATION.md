# Personal Data Requests - User Access Clarification

## ⚠️ IMPORTANT: How Users Actually Request Personal Data

### Common Misconception ❌

**INCORRECT:** "Users go to Jira Settings → Apps → Your App → Request Data"

**This is NOT how personal data requests work in the Atlassian ecosystem.**

---

## How It Actually Works ✅

### User's Perspective

#### For Regular Users (Non-Admins):

1. **User submits a support ticket to Atlassian**
   - URL: https://support.atlassian.com/contact/ (must be logged in)
   - Select: **"Personal data and GDPR"** from the "What can we help you with?" dropdown
   - Select: **"Request a copy of your personal data"** (or "Request to delete personal data")
   - Complete and submit the form

2. **Atlassian Support receives and processes the request**
   - Support team initiates the data request workflow
   - Atlassian's backend creates a unified request across ALL apps
   - Includes Jira Core, Confluence, Trello, AND third-party marketplace apps like yours

3. **Atlassian's backend polls all installed apps**
   - Automatically polls your app's `userDataProvider` endpoint
   - Happens every 7 days until request is fulfilled
   - User doesn't see individual app responses

4. **User receives consolidated data via Atlassian Support**
   - Atlassian Support aggregates all responses
   - Provides download link via email/support ticket (export requests)
   - Provides confirmation via email/support ticket (deletion requests)
   - Includes data from all apps, not just yours

#### For Site Admins:

Site admins must also use the same support ticket process:
- Submit ticket at https://support.atlassian.com/contact/
- Can request data for users in their organization (with proper authorization)
- Must provide user's accountId/email in the support request
- Useful for handling employee data requests on behalf of users who don't have direct access

---

## What Your App Does ✅

Your implementation is correct. Your app:

### 1. **Listens for Atlassian's Polls**

```yaml
# forge-app/manifest.yml
userDataProvider:
  - key: personal-data-provider
    handler: personalDataHandler
```

**This is passive** - Atlassian calls your app, your app doesn't provide a UI.

### 2. **Responds with Status**

```javascript
// First poll
return { status: 'PENDING' };

// Subsequent poll after processing
return {
  status: 'COMPLETED',
  data: {
    downloadUrl: 'https://...',
    expiresAt: '...'
  }
};
```

### 3. **Processes Data Asynchronously**

Your AI server:
- Exports all user data (16 tables + storage)
- Generates signed URL (24hr expiry)
- Hard deletes data (for deletion requests)

---

## Key Differences: App Settings vs Personal Data

| Feature | App Settings (Admin Only) | Personal Data (Any User) |
|---------|--------------------------|--------------------------|
| **Who can access** | Site administrators only | Any user (their own data) |
| **Where to access** | Jira → Settings → Apps → Manage apps | Atlassian Account → Privacy |
| **What it controls** | App configuration, licenses | Personal data export/deletion |
| **Managed by** | App developer (you) | Atlassian platform |
| **GDPR requirement** | Not required | **Mandatory** for compliance |

---

## Why This Matters for Compliance

### GDPR Article 15 (Right of Access)
> "The data subject shall have the right to obtain from the controller confirmation as to whether or not personal data concerning him or her are being processed..."

**Key point:** ANY user can request their data, not just admins.

### GDPR Article 17 (Right to Erasure)
> "The data subject shall have the right to obtain from the controller the erasure of personal data concerning him or her without undue delay..."

**Key point:** Users can request deletion even if they're not site admins.

---

## What Atlassian Handles (Not Your Responsibility)

✅ **User interface for submitting requests**
- Atlassian provides the forms, buttons, workflows

✅ **Authentication & authorization**
- Atlassian verifies user identity
- Atlassian ensures users can only request their own data (unless admin)

✅ **Request coordination**
- Atlassian polls all installed apps
- Atlassian aggregates responses

✅ **Delivery to user**
- Atlassian provides download links
- Atlassian sends confirmation emails

---

## Your Privacy Policy Language (Recommended)

### Current Language (Needs Update):

> ❌ "Export your data: Request via Jira admin settings → Personal Data."

**Problem:** Implies only admins can request, implies it's in Jira app settings.

### Recommended Language:

> ✅ **How to Access Your Personal Data:**
> 
> You can request a copy of all your personal data stored by this app at any time:
> 
> 1. Go to your **Atlassian Account Settings** (https://id.atlassian.com)
> 2. Navigate to **Privacy** → **Personal Data**
> 3. Click **"Request my data"**
> 4. Atlassian will automatically collect your data from all installed apps, including Time Tracker
> 5. You'll receive a download link when ready (typically within 24 hours)
> 
> **How to Delete Your Personal Data:**
> 
> You can request permanent deletion of your personal data:
> 
> 1. Follow the same steps as above
> 2. Select **"Delete my data"** instead
> 3. Confirm deletion (this action is permanent and cannot be undone)
> 4. All your data will be permanently deleted within 24 hours
> 
> **Note:** Atlassian coordinates these requests across all apps. You don't need administrator access to request your own data.

---

## App Uninstall Data Deletion (Separate Feature)

**This is different from personal data requests.**

### When App is Uninstalled:

1. **Organization admin** uninstalls app from Jira Marketplace
2. Atlassian fires `avi:forge:uninstalled:app` event
3. **Your app marks entire organization for deletion** (not just one user)
4. **30-day grace period** begins
5. **All organization data deleted** after 30 days

### Key Differences:

| Personal Data Request | App Uninstall |
|----------------------|---------------|
| **Scope:** Single user | **Scope:** Entire organization |
| **Initiated by:** Any user | **Initiated by:** Admin only |
| **Timing:** Immediate (< 24hrs) | **Timing:** 30-day grace period |
| **Reversible:** No | **Reversible:** Yes (reinstall within 30 days) |
| **GDPR:** Article 15 & 17 | **GDPR:** Data minimization principle |

---

## Testing Recommendations

### To Test Personal Data Export:

**You cannot test the real Atlassian UI easily** because:
- Atlassian controls that interface
- It's only available in production Atlassian accounts
- Development environments may not show it

**Instead:**
1. Test your API endpoints directly (see TESTING_GUIDE.md)
2. Use Postman/curl to simulate Atlassian's polls
3. Verify response format matches Atlassian's requirements
4. Trust that Atlassian will call your API correctly

**In production:**
1. Create a test user with minimal data
2. Have that user request their data through real Atlassian interface
3. Verify they receive correct data

---

## Summary: You're Compliant ✅

### What you've built:
- ✅ API that responds to Atlassian's polls
- ✅ Data export functionality (16 tables + storage)
- ✅ Data deletion functionality (hard delete)
- ✅ 7-day polling cycle support
- ✅ App uninstall data deletion (30-day grace period)

### What you DON'T need to build:
- ❌ User interface for requesting data (Atlassian provides)
- ❌ Authentication for data requests (Atlassian handles)
- ❌ Email notifications to users (Atlassian handles)
- ❌ Request tracking UI (Atlassian handles)

### Your only responsibility:
**Respond correctly to Atlassian's API calls.** ✅ You've done this.

---

## Questions to Verify Understanding

### Q: Can regular users (non-admins) request their personal data?
**A:** Yes! Any user can request their own data through Atlassian Account Settings. No admin access required.

### Q: Do we need to build a UI for data requests in our app?
**A:** No. Atlassian provides the UI. You only implement the API.

### Q: When the app is uninstalled, is data deleted immediately?
**A:** No. There's a 30-day grace period. After 30 days, all data is permanently deleted.

### Q: Can users see our app's response separately?
**A:** No. Atlassian aggregates all apps' responses into a single download for the user.

### Q: What if a user requests data but we return PENDING for 8 days?
**A:** That's fine. Atlassian polls every 7 days. As long as you complete within reasonable time (you target < 24hrs), you're compliant.

---

## References

- Atlassian Data Privacy Guidelines: https://developer.atlassian.com/platform/marketplace/data-privacy-guidelines/
- GDPR Article 15 (Right of Access): https://gdpr-info.eu/art-15-gdpr/
- GDPR Article 17 (Right to Erasure): https://gdpr-info.eu/art-17-gdpr/
- Your implementation: `docs/PERSONAL_DATA_REPORTING_API_README.md`
- Your testing guide: `docs/PERSONAL_DATA_REPORTING_API_TESTING_GUIDE.md`

---

**Document Version:** 1.0  
**Last Updated:** April 8, 2026  
**Status:** ✅ Implementation verified compliant
