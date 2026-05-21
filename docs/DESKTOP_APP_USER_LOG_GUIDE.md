# TimeTracker Desktop App - Viewing Your Logs

**Quick Guide for Users**

---

## 📁 Where Are My Logs?

Your TimeTracker logs are saved on your computer at:

```
%LOCALAPPDATA%\TimeTracker\logs\
```

**Full path example:**
```
C:\Users\YourName\AppData\Local\TimeTracker\logs\
```

---

## 🔍 How to Find Your Logs

### Method 1: Using Windows Run (Fastest)

1. Press `Win + R` on your keyboard
2. Type: `%LOCALAPPDATA%\TimeTracker\logs`
3. Press Enter
4. You'll see your log files!

### Method 2: Using File Explorer

1. Open File Explorer
2. Click the address bar at the top
3. Type: `%LOCALAPPDATA%\TimeTracker\logs`
4. Press Enter

### Method 3: Manual Navigation

1. Open File Explorer
2. Navigate to: `C:\Users\[YourUsername]\AppData\Local\TimeTracker\logs\`
   - Replace `[YourUsername]` with your Windows username

---

## 📄 Understanding Your Log Files

You'll see several log files:

| File | Description |
|------|-------------|
| `timetracker.log` | **Most recent log** - Start here! |
| `timetracker.log.1` | Previous log (from yesterday) |
| `timetracker.log.2` | Older log |
| `timetracker.log.3` | Even older log |
| `timetracker.log.4` | Oldest log |

**Note:** The app keeps up to 5 log files. Each file can be up to 10MB. Old logs are automatically deleted.

---

## 👁️ How to View Logs

### Quick View

**Double-click** `timetracker.log` - it will open in Notepad

### Search for Specific Issues

1. Open `timetracker.log` in Notepad
2. Press `Ctrl + F` to search
3. Search for keywords like:
   - `ERROR` - Find errors
   - `session expired` - Find authentication issues
   - `TRACKING STARTED` - See when tracking began
   - `Network` - Find connectivity issues

---

## 🆘 Sharing Logs with Support

If you need help from our support team:

### Step 1: Find the Logs Folder
```
Win + R  →  Type: %LOCALAPPDATA%\TimeTracker\logs  →  Enter
```

### Step 2: Zip All Log Files
1. Select all `.log` files (hold Ctrl and click each file)
2. Right-click → "Send to" → "Compressed (zipped) folder"
3. Name it: `TimeTracker-Logs-[YourName].zip`

### Step 3: Attach to Support Ticket
- Attach the ZIP file to your support email/ticket
- Include a brief description of your issue

**Don't worry about privacy:** 
- ✅ Logs automatically hide sensitive information (emails, passwords, tokens)
- ✅ We only use logs to fix your issue
- ✅ Logs are deleted after your issue is resolved

---

## 🔒 Privacy & Security

### What's in the Logs?

**✅ Included (helpful for troubleshooting):**
- When the app started/stopped
- Authentication success/failure (but NOT your password)
- Tracking activity timestamps
- Error messages
- Network connectivity status

**❌ NOT Included (automatically removed):**
- Your password
- Email addresses (shown as `[EMAIL]`)
- Authentication tokens (shown as `[JWT]`)
- Credit card numbers (shown as `[CREDIT_CARD]`)
- Personal identification numbers

### Can I Delete Logs?

**Yes!** You can delete log files anytime:
- They're only stored on your computer
- No copies sent to our servers (unless you share them with support)
- Deleting logs won't affect the app's operation

---

## 🐛 Common Issues & Log Patterns

### Issue: "Session Expired" Notification

**What to Look For:**
```
Search for: "Token refresh"
```

**If you see:**
```
Token refresh FAILED after all attempts
network_status=offline
```
**Problem:** Your internet connection dropped during login
**Solution:** Check your network, try logging in again

---

### Issue: Tracking Not Starting

**What to Look For:**
```
Search for: "TRACKING STARTED"
```

**If NOT found:**
- Check earlier in the log for errors
- Look for `[ERROR]` entries
- Share logs with support team

**If found:**
```
TRACKING STARTED
User ID: [UUID]
Supabase initialized: True
```
**Status:** Tracking is working!

---

### Issue: App Crashes on Startup

**What to Look For:**
```
Look at the END of timetracker.log
```

**If you see:**
```
[ERROR] Fatal application error: ...
Traceback (most recent call last):
```
**Action:** This shows the crash details - share the last 50 lines with support

---

## 🛠️ Advanced: Reading Log Entries

### Log Entry Format

```
2026-05-20 14:30:45,123 - INFO - TRACKER - Tracking started
└─[Timestamp]─┘   └[Level]┘  └[Part]┘  └─[Message]───┘
```

**Timestamp:** When something happened
**Level:** Importance
  - `INFO` - Normal operation
  - `WARNING` - Potential issue
  - `ERROR` - Something failed
  - `CRITICAL` - Major problem

**Part:** Which part of the app
  - `MAIN` - Main application
  - `AUTH` - Login/authentication
  - `TRACKER` - Activity tracking
  - `OCR` - Text extraction
  - `NETWORK` - Internet connectivity

**Message:** What happened

---

## 📞 Need Help?

### Can't Find Logs?

**Try this:**
1. Open Command Prompt (search "cmd" in Start menu)
2. Type: `dir "%LOCALAPPDATA%\TimeTracker\logs"`
3. Press Enter
4. Share the output with support

### Logs Show Errors?

**Don't panic!**
- Some errors are normal (network hiccups, etc.)
- Look for patterns (same error repeating)
- Contact support with:
  - What you were doing when the problem occurred
  - When it started happening
  - Your log files (zipped)

### Contact Support

📧 **Email:** [support email]
🌐 **Help Center:** [help center URL]
💬 **Chat:** Available in the TimeTracker dashboard

**When contacting support, include:**
1. Your log files (zipped)
2. Description of the issue
3. When it started
4. What you were doing when it occurred

---

## ✅ Quick Checklist

Before contacting support, try these:

- [ ] Check if logs folder exists (`%LOCALAPPDATA%\TimeTracker\logs`)
- [ ] Open most recent log (`timetracker.log`)
- [ ] Search for `ERROR` to find problems
- [ ] Check last 20 lines for recent activity
- [ ] Zip all log files if sharing with support
- [ ] Include description of your issue

---

## 🎓 Tips & Tricks

### Tip 1: Check Logs After Each Issue
If something goes wrong, immediately check the logs. The most recent entries show what just happened.

### Tip 2: Look for Timestamps
Match log timestamps to when you experienced the issue.

### Tip 3: Context is Key
Look at 5-10 lines before and after an error for context.

### Tip 4: Pattern Recognition
If you see the same error repeating every few minutes, that's a clue!

### Tip 5: Fresh Start
After troubleshooting, you can delete old logs to start fresh (app will create new ones).

---

## 📚 Additional Resources

- **Installation Guide:** [link]
- **Troubleshooting Guide:** [link]
- **FAQ:** [link]
- **Privacy Policy:** [link]

---

**Last Updated:** May 20, 2026  
**Version:** 1.0  
**Applies to:** TimeTracker Desktop App v1.4.3+
