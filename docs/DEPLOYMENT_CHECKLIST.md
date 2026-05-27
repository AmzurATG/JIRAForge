# Deployment Checklist ✅

Use this checklist while following the main deployment guide.

---

## Before You Start

- [ ] ai-server is deployed and running
- [ ] You know your ai-server URL: ___________________________
- [ ] Code is pushed to GitHub repository
- [ ] You have GitHub account credentials

---

## Step 1: Vercel Account (5 min)

- [ ] Created Vercel account at https://vercel.com
- [ ] Connected GitHub account to Vercel
- [ ] Can see Vercel dashboard

---

## Step 2: Prepare Code (10 min)

- [ ] Ran `npm install` in `ai-server/src/portal/`
- [ ] Ran `npm run build` successfully (no errors)
- [ ] Created `vercel.json` file ✅ (already done!)
- [ ] Committed and pushed vercel.json to GitHub

---

## Step 3: Deploy to Vercel (10 min)

- [ ] Imported project to Vercel
- [ ] Set Root Directory: `ai-server/src/portal`
- [ ] Added environment variable:
  - Key: `VITE_API_BASE_URL`
  - Value: _____________________________ (your ai-server URL)
- [ ] Clicked "Deploy" button
- [ ] Deployment succeeded ✅
- [ ] Noted Vercel URL: ___________________________

---

## Step 4: Update Google OAuth (5 min)

- [ ] Opened Google Cloud Console credentials
- [ ] Added redirect URI: `https://__________.vercel.app/auth/google/callback`
- [ ] Clicked "Save" in Google Console
- [ ] Updated ai-server `.env`:
  - `GOOGLE_CALLBACK_URL=https://__________.vercel.app/auth/google/callback`
  - `PORTAL_BASE_URL=https://__________.vercel.app`
- [ ] Restarted ai-server
- [ ] Updated CORS in `ai-server/src/index.js`
- [ ] Committed, pushed, and restarted ai-server

---

## Step 5: Test Deployment (10 min)

- [ ] Portal loads at Vercel URL
- [ ] Login page shows "Sign in with Google" button
- [ ] Google login popup opens
- [ ] Successfully logged in
- [ ] Dashboard page loads with data
- [ ] Tested Time Logs page
- [ ] Tested Employees page
- [ ] Tested Reports page
- [ ] Tested Settings page
- [ ] No errors in browser DevTools Console
- [ ] API calls succeed (checked Network tab)

---

## Post-Deployment

- [ ] Saved Vercel URL for future reference
- [ ] Shared URL with team
- [ ] Set up monitoring (Vercel Analytics)
- [ ] Documented any issues encountered
- [ ] Celebrated successful first deployment! 🎉

---

## Important URLs

| What | URL |
|------|-----|
| **Vercel Portal** | https://_________________________________ |
| **ai-server** | https://_________________________________ |
| **Vercel Dashboard** | https://vercel.com/dashboard |
| **Google Cloud Console** | https://console.cloud.google.com/apis/credentials |

---

## Quick Troubleshooting

### If Google login fails:
1. Check redirect URI in Google Console matches exactly
2. Wait 5 minutes after updating Google Console
3. Clear browser cache

### If API calls fail:
1. Check `VITE_API_BASE_URL` in Vercel environment variables
2. Check CORS settings in ai-server
3. Restart ai-server
4. Check ai-server logs

### If page shows 404:
1. Check vercel.json routing (already configured ✅)
2. Redeploy from Vercel dashboard

---

## After Making Code Changes

To redeploy after updates:

```powershell
# Automatic (just push to GitHub)
git add .
git commit -m "Your changes"
git push origin feat/admin-portal/web

# Vercel auto-deploys! ✨
```

---

## Status Tracker

**Deployment Date:** _________________

**Deployment Status:** 
- [ ] In Progress
- [ ] Testing
- [ ] Live ✅

**Issues Encountered:**
1. 
2. 
3. 

**Resolved:**
- [ ] All issues fixed

---

**Ready to deploy? Start with Step 1!**

📖 See full guide: `PRODUCTIVITY_PORTAL_DEPLOYMENT_GUIDE.md`
