/**
 * Download Reminder Email Template
 * 
 * Sent to users who have logged in but haven't downloaded the desktop app.
 */

module.exports = {
    type: 'download_reminder',
    
    subject: 'You\'re almost there! Let\'s get TimeTracker set up 🎉',
    
    /**
     * Generate plain text email body
     * @param {Object} data - Template data
     * @param {string} data.displayName - User's display name
     * @param {string} data.downloadUrl - URL to download the app
     * @param {string} [data.platform] - Platform name (Windows, macOS, Linux)
     * @returns {string} Plain text email body
     */
    text: ({ displayName, downloadUrl, platform = 'Windows' }) => `
Hello ${displayName},

We're so glad you're here! 😊 You're just one step away from unlocking the full TimeTracker experience.

The TimeTracker Desktop App will help you:
✓ Automatically track your time while you work (no manual entry needed!)
✓ Monitor your activity with smart OCR technology
✓ Seamlessly sync with your Jira worklogs
✓ Track time even when you're offline

Ready to get started? Download for ${platform}: ${downloadUrl}

Installation is super quick and easy - usually takes less than 2 minutes! Just download, install, and sign in with your Atlassian account.

Need a hand? We're here to help! Check out our setup guide or reach out to our friendly support team anytime.

Warm regards,
The TimeTracker Team

---
You're receiving this because you signed up for TimeTracker.
    `.trim(),
    
    /**
     * Generate HTML email body
     * @param {Object} data - Template data
     * @returns {string} HTML email body
     */
    html: ({ displayName, downloadUrl, platform = 'Windows' }) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Download TimeTracker Desktop App</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            margin: 0;
            padding: 0;
            background-color: #f5f5f5;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 40px 20px;
        }
        .card {
            background: white;
            border-radius: 8px;
            padding: 40px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .logo {
            text-align: center;
            margin-bottom: 30px;
        }
        .logo h1 {
            color: #0052CC;
            margin: 0;
            font-size: 24px;
        }
        h2 {
            color: #333;
            margin-top: 0;
        }
        .button {
            display: inline-block;
            padding: 14px 28px;
            background: #00875A;
            color: white !important;
            text-decoration: none;
            border-radius: 4px;
            font-weight: 500;
            margin: 20px 0;
        }
        .button:hover {
            background: #006644;
        }
        .features {
            background: #E3FCEF;
            border: 1px solid #ABF5D1;
            padding: 20px;
            border-radius: 4px;
            margin: 20px 0;
        }
        .features ul {
            margin: 0;
            padding-left: 0;
            list-style: none;
        }
        .features li {
            margin: 10px 0;
            padding-left: 28px;
            position: relative;
        }
        .features li::before {
            content: "✓";
            position: absolute;
            left: 0;
            color: #00875A;
            font-weight: bold;
        }
        .steps {
            background: #F4F5F7;
            padding: 20px;
            border-radius: 4px;
            margin: 20px 0;
        }
        .steps ol {
            margin: 0;
            padding-left: 20px;
        }
        .steps li {
            margin: 8px 0;
        }
        .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            color: #666;
            font-size: 12px;
            text-align: center;
        }
        .platform-badge {
            display: inline-block;
            background: #0052CC;
            color: white;
            padding: 4px 12px;
            border-radius: 4px;
            font-size: 14px;
            margin-left: 8px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            <div class="logo">
                <h1>🚀 TimeTracker</h1>
            </div>
            
            <h2>Hello ${displayName}! 👋</h2>
            
            <p>We're excited to have you on board! You're just one quick step away from experiencing the full power of TimeTracker.</p>
            
            <div class="features">
                <strong>Here's what you'll love about the Desktop App:</strong>
                <ul>
                    <li>Automatic time tracking while you work (no manual entry!)</li>
                    <li>Smart screenshot-based activity monitoring</li>
                    <li>Seamless Jira worklog synchronization</li>
                    <li>Offline support - track time even without internet</li>
                </ul>
            </div>
            
            <p style="text-align: center;">
                <a href="${downloadUrl}" class="button">
                    ⬇️ Download for ${platform}
                </a>
            </p>
            
            <div class="steps">
                <strong>Super Easy Setup (about 2 minutes):</strong>
                <ol>
                    <li>Download the installer</li>
                    <li>Run the installer</li>
                    <li>Sign in with your Atlassian account</li>
                    <li>You're all set - start tracking!</li>
                </ol>
            </div>
            
            <p>Need a hand getting started? We're here to help! Reach out to our support team.</p>
            
            <p>Warm regards,<br><strong>The TimeTracker Team</strong></p>
            
            <div class="footer">
                <p>You're receiving this email because you signed up for TimeTracker.</p>
            </div>
        </div>
    </div>
</body>
</html>
    `.trim()
};
