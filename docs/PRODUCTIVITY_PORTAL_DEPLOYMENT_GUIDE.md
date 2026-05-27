# Productivity Portal Deployment Guide for Beginners

**Your First Deployment! 🚀**

This guide will walk you through deploying the Productivity Portal frontend to Vercel step-by-step.

---

## 📋 Pre-Deployment Checklist

Before starting, confirm you have:

- ✅ **ai-server already deployed** (you mentioned it's done)
- ✅ **ai-server URL** (e.g., `https://forgesync.amzur.com` or your domain)
- ✅ **Git repository** with latest code pushed to `feat/admin-portal/web` branch
- ✅ **GitHub account** (for connecting to Vercel)
- ✅ **Google Cloud Console access** (to update OAuth callback URLs)

---

## 🎯 Deployment Overview

**What we're deploying:**
- **Frontend:** React app in `ai-server/src/portal/` → Vercel
- **Backend:** ai-server (Express) → Already deployed ✅

**Architecture after deployment:**
```
User Browser → Vercel (React Portal) → ai-server (API) → Supabase (Database)
```

---

## Step 1: Create Vercel Account (5 minutes)

1. **Go to:** https://vercel.com
2. **Click:** "Sign Up"
3. **Choose:** "Continue with GitHub" (easiest option)
4. **Authorize:** Allow Vercel to access your GitHub account
5. **Complete:** Follow any prompts to finish account setup

> 💡 **Tip:** Vercel's free tier is perfect for this project!

---

## Step 2: Prepare Your Code (10 minutes)

### 2.1 Verify Build Works Locally

Open terminal in `D:\JIRAForge\ai-server\src\portal\`:

```powershell
# Navigate to portal directory
cd D:\JIRAForge\ai-server\src\portal

# Install dependencies (if not already done)
npm install

# Test the build
npm run build
```

**Expected result:** Build completes without errors, creates `build/` folder.

### 2.2 Create Vercel Configuration File

Create a new file: `D:\JIRAForge\ai-server\src\portal\vercel.json`

```json
{
  "version": 2,
  "builds": [
    {
      "src": "package.json",
      "use": "@vercel/static-build",
      "config": {
        "distDir": "build"
      }
    }
  ],
  "routes": [
    {
      "src": "/static/(.*)",
      "dest": "/static/$1"
    },
    {
      "src": "/favicon.ico",
      "dest": "/favicon.ico"
    },
    {
      "src": "/manifest.json",
      "dest": "/manifest.json"
    },
    {
      "src": "/(.*)",
      "dest": "/index.html"
    }
  ]
}
```

> 📝 **What this does:** Tells Vercel how to build and serve your React app.

### 2.3 Commit and Push Changes

```powershell
# From D:\JIRAForge
git add ai-server/src/portal/vercel.json
git commit -m "Add Vercel configuration for portal deployment"
git push origin feat/admin-portal/web
```

---

## Step 3: Deploy to Vercel (10 minutes)

### 3.1 Import Project to Vercel

1. **Go to:** https://vercel.com/dashboard
2. **Click:** "Add New..." → "Project"
3. **Find your repository:** Search for "JIRAForge" (or your repo name)
4. **Click:** "Import" next to your repository

### 3.2 Configure Project Settings

Vercel will show an import screen. Configure these settings:

**Framework Preset:**
- Select: "Create React App"

**Root Directory:**
- Click "Edit" next to Root Directory
- Enter: `ai-server/src/portal`
- Click "Continue"

**Build and Output Settings:**
- Build Command: `npm run build` (should be auto-filled)
- Output Directory: `build` (should be auto-filled)
- Install Command: `npm install` (should be auto-filled)

> ⚠️ **Important:** Make sure Root Directory is set to `ai-server/src/portal`!

### 3.3 Add Environment Variables

Still on the import screen, scroll down to "Environment Variables" section.

Click "Add" and enter:

| Name | Value | Example |
|------|-------|---------|
| `VITE_API_BASE_URL` | Your ai-server URL | `https://forgesync.amzur.com` |

**How to add:**
1. Type: `VITE_API_BASE_URL` in "Key" field
2. Type: Your ai-server URL in "Value" field (e.g., `https://forgesync.amzur.com`)
3. **DO NOT** add trailing slash `/`
4. Click "Add"

> 💡 **What this does:** Tells your frontend where to find the backend API.

### 3.4 Deploy!

1. **Click:** "Deploy" button (bottom of screen)
2. **Wait:** Vercel will build and deploy (takes 2-5 minutes)
3. **Watch:** You'll see build logs in real-time

**Expected result:** 
- ✅ Build successful
- ✅ Deployment URL shown (e.g., `https://your-project.vercel.app`)

---

## Step 4: Update Google OAuth Settings (5 minutes)

Your portal URL has changed, so Google OAuth needs to know about it.

### 4.1 Get Your Vercel URL

After deployment, Vercel shows your URL. It looks like:
```
https://your-project-name.vercel.app
```

Copy this URL! You'll need it for the next steps.

### 4.2 Update Google Cloud Console

1. **Go to:** https://console.cloud.google.com/apis/credentials
2. **Select:** Your project (if you have multiple)
3. **Click:** Your OAuth 2.0 Client ID (the one you're using)
4. **Scroll to:** "Authorized redirect URIs"
5. **Click:** "+ ADD URI"
6. **Enter:** `https://your-project-name.vercel.app/auth/google/callback`
   - Replace `your-project-name.vercel.app` with your actual Vercel URL
7. **Click:** "Save"

> ⚠️ **Critical:** The callback URL must match EXACTLY, including `/auth/google/callback`

**Example:**
```
If your Vercel URL is: https://productivity-portal.vercel.app
Then add: https://productivity-portal.vercel.app/auth/google/callback
```

### 4.3 Update ai-server Environment Variables

You need to update your deployed ai-server's `.env` file with the new Vercel URL.

**On your ai-server (wherever it's deployed):**

1. Open the `.env` file
2. Find these lines:
   ```
   GOOGLE_CALLBACK_URL=http://localhost:3002/auth/google/callback
   PORTAL_BASE_URL=http://localhost:3002
   ```
3. Update them:
   ```
   GOOGLE_CALLBACK_URL=https://your-project-name.vercel.app/auth/google/callback
   PORTAL_BASE_URL=https://your-project-name.vercel.app
   ```
4. Save the file
5. Restart the ai-server:
   ```bash
   pm2 restart ai-server
   # OR
   npm start
   ```

### 4.4 Update CORS Settings

Your ai-server needs to allow requests from the Vercel domain.

**In your ai-server code** (file: `ai-server/src/index.js`):

Find the CORS configuration (around line 50-60) and ensure your Vercel URL is in `allowedOrigins`:

```javascript
const allowedOrigins = [
  'http://localhost:3002',
  'https://your-project-name.vercel.app'  // Add this line
];
```

**Then:**
```bash
# Commit and deploy the change
git add ai-server/src/index.js
git commit -m "Add Vercel URL to CORS allowedOrigins"
git push

# Restart ai-server
pm2 restart ai-server
```

---

## Step 5: Test Your Deployment (10 minutes)

### 5.1 Basic Tests

1. **Open:** `https://your-project-name.vercel.app` in browser
2. **Check:** Login page loads
3. **Click:** "Sign in with Google"
4. **Check:** Google login popup opens
5. **Login:** Complete Google authentication
6. **Check:** Redirects back to portal and shows dashboard

### 5.2 Test All Pages

Visit each page and verify it works:

- ✅ Dashboard (`/dashboard`)
- ✅ Time Logs (`/time-logs`)
- ✅ Employees (`/employees`)
- ✅ Reports (`/reports`)
- ✅ Settings (`/settings`)

### 5.3 Test API Communication

1. **Go to:** Dashboard page
2. **Open:** Browser DevTools (F12)
3. **Click:** "Network" tab
4. **Refresh:** Page
5. **Look for:** Requests to your ai-server URL (should show 200 status)

**If you see errors:**
- 404 or CORS errors → Check Step 4.4 (CORS settings)
- 401 Unauthorized → Check authentication/token
- 500 Server Error → Check ai-server logs

---

## Step 6: Set Up Custom Domain (Optional, 15 minutes)

If you want a custom domain like `portal.yourcompany.com`:

### 6.1 In Vercel Dashboard

1. **Go to:** Your project in Vercel
2. **Click:** "Settings" tab
3. **Click:** "Domains" in sidebar
4. **Enter:** Your domain name (e.g., `portal.yourcompany.com`)
5. **Click:** "Add"

### 6.2 Vercel Will Show DNS Instructions

You'll see something like:
```
Add these DNS records to your domain provider:

Type: CNAME
Name: portal
Value: cname.vercel-dns.com
```

### 6.3 Update Your Domain Provider

1. **Go to:** Your domain provider (GoDaddy, Namecheap, Cloudflare, etc.)
2. **Find:** DNS settings
3. **Add:** The CNAME record Vercel showed you
4. **Wait:** 5-60 minutes for DNS to propagate

### 6.4 Update Google OAuth and ai-server Again

Repeat Step 4.2 and 4.3, but use your custom domain instead:
```
https://portal.yourcompany.com/auth/google/callback
```

---

## 🔧 Troubleshooting Common Issues

### Issue 1: "Page Not Found" (404)

**Symptoms:** Navigating to `/dashboard` or other routes shows 404

**Solution:**
- Check `vercel.json` routing configuration (Step 2.2)
- Redeploy: Vercel Dashboard → Deployments → Click "..." → Redeploy

---

### Issue 2: Google Login Fails with "redirect_uri_mismatch"

**Symptoms:** Google shows error about redirect URI

**Solution:**
1. Check Google Cloud Console authorized redirect URIs
2. Make sure callback URL matches EXACTLY (including https://)
3. Wait 5 minutes after updating Google Cloud Console

---

### Issue 3: API Calls Fail with CORS Error

**Symptoms:** Browser console shows "CORS policy blocked"

**Solution:**
1. Check ai-server CORS settings (Step 4.4)
2. Make sure Vercel URL is in `allowedOrigins`
3. Restart ai-server after changes
4. Clear browser cache (Ctrl+Shift+Delete)

---

### Issue 4: Build Fails on Vercel

**Symptoms:** Vercel shows build errors

**Solution:**
1. Check build logs in Vercel dashboard
2. Verify build works locally: `npm run build`
3. Check Node.js version compatibility
4. Look for missing dependencies

---

### Issue 5: Dashboard Shows No Data

**Symptoms:** Portal loads but shows empty/no data

**Solution:**
1. Check `VITE_API_BASE_URL` environment variable (Step 3.3)
2. Open DevTools → Network tab → Look for failed API calls
3. Verify ai-server is running and accessible
4. Check ai-server logs for errors

---

### Issue 6: "Maximum Update Depth" Error

**Symptoms:** React shows infinite loop error

**Solution:**
1. Clear browser cache
2. Hard refresh: Ctrl+Shift+R
3. Check for useEffect dependency issues in code

---

## 📊 Monitoring Your Deployment

### Vercel Analytics (Built-in)

1. **Go to:** Your project in Vercel dashboard
2. **Click:** "Analytics" tab
3. **View:** Page views, performance, errors

### Check Deployment Status

1. **Go to:** Vercel Dashboard → Your project
2. **Click:** "Deployments" tab
3. **See:** All deployment history, build logs, status

### View Runtime Logs

1. **Go to:** Your project in Vercel
2. **Click:** "Deployments" → Select a deployment
3. **Click:** "Functions" → View logs

---

## 🚀 Redeploying After Code Changes

When you make code changes and want to deploy:

### Automatic Deployment (Recommended)

Vercel automatically deploys when you push to your connected branch:

```powershell
# Make your changes
git add .
git commit -m "Your changes description"
git push origin feat/admin-portal/web
```

Vercel detects the push and deploys automatically! 🎉

### Manual Deployment

If you need to manually trigger a deployment:

1. **Go to:** Vercel Dashboard → Your project
2. **Click:** "Deployments" tab
3. **Click:** "..." on latest deployment
4. **Click:** "Redeploy"

---

## 🎓 Post-Deployment Checklist

After successful deployment, verify:

- ✅ **Portal accessible** at Vercel URL
- ✅ **Google login works** end-to-end
- ✅ **Dashboard loads data** from ai-server
- ✅ **All pages work** (Dashboard, Time Logs, Employees, Reports, Settings)
- ✅ **Filters work** correctly
- ✅ **API calls succeed** (check DevTools Network tab)
- ✅ **CORS configured** properly
- ✅ **No console errors** in browser DevTools

---

## 📚 Important URLs to Save

After deployment, save these for reference:

| Service | URL | Purpose |
|---------|-----|---------|
| **Vercel Dashboard** | https://vercel.com/dashboard | Manage deployments |
| **Your Portal** | `https://your-project.vercel.app` | Live portal |
| **ai-server** | Your ai-server URL | Backend API |
| **Google Cloud Console** | https://console.cloud.google.com | OAuth settings |
| **Vercel Docs** | https://vercel.com/docs | Help & guides |

---

## 💰 Cost Breakdown

**Vercel Free Tier includes:**
- ✅ Unlimited deployments
- ✅ 100 GB bandwidth per month
- ✅ Automatic HTTPS/SSL
- ✅ Global CDN
- ✅ Unlimited websites

**This is FREE for your portal! 🎉**

---

## 🆘 Need Help?

If you get stuck:

1. **Check this guide** again for your specific issue
2. **Check Vercel logs** in dashboard
3. **Check ai-server logs** for API errors
4. **Check browser DevTools console** for frontend errors
5. **Vercel Support Docs:** https://vercel.com/docs

---

## 🎯 Next Steps After Deployment

1. **Share the URL** with your team
2. **Set up monitoring** (Vercel Analytics + ai-server logs)
3. **Create admin accounts** via Settings page
4. **Test thoroughly** with real users
5. **Consider custom domain** if needed (Step 6)

---

## 📝 Summary

**What you accomplished:**
1. ✅ Deployed React portal to Vercel
2. ✅ Connected frontend to ai-server backend
3. ✅ Configured Google OAuth for production
4. ✅ Set up CORS properly
5. ✅ Tested end-to-end functionality

**Your architecture now:**
```
Users → https://your-project.vercel.app (React Portal)
          ↓
        ai-server (Express API)
          ↓
        Supabase (PostgreSQL Database)
```

---

## 🎉 Congratulations!

You've successfully deployed your first production application! 🚀

This is a major milestone. You now have a live portal that your team can access from anywhere.

**Remember:**
- Vercel auto-deploys on every push to your branch
- Always test changes locally before pushing
- Monitor Vercel dashboard for issues
- Keep your environment variables secure

**You did it! Welcome to the world of deployment! 🌟**

---

## Quick Reference Commands

```powershell
# Test build locally
cd D:\JIRAForge\ai-server\src\portal
npm run build

# Push code (triggers auto-deploy on Vercel)
git add .
git commit -m "Description of changes"
git push origin feat/admin-portal/web

# View Vercel deployment logs
# Go to: https://vercel.com/dashboard → Your Project → Deployments

# Check ai-server status (on server)
pm2 status
pm2 logs ai-server
```

---

**Document Version:** 1.0  
**Last Updated:** May 26, 2026  
**Author:** For first-time deployers  
**Difficulty:** Beginner-friendly ⭐
