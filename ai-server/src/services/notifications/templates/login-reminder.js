/**
 * Login Reminder Email Template
 * 
 * Sent to users who haven't logged into the system for a specified period.
 */

module.exports = {
    type: 'login_reminder',
    
    subject: 'Your TimeTracker Account Awaits Your Return',
    
    /**
     * Generate plain text email body
     * @param {Object} data - Template data
     * @param {string} data.displayName - User's display name
     * @param {string} data.loginUrl - URL to login
     * @param {string} [data.lastLoginDate] - Last login date (optional)
     * @returns {string} Plain text email body
     */
    text: ({ displayName, loginUrl, lastLoginDate }) => `
Hello ${displayName},

I hope you're doing well! 😊

We noticed it's been a while since you've logged into TimeTracker, and we wanted to reach out.${lastLoginDate ? `\n\nYour last visit was on ${lastLoginDate}.` : ''}

Whenever you're ready, we'd love to see you back:
${loginUrl}

Here's what's waiting for you:
- Automatic time tracking that links directly to your Jira issues
- Easy worklog synchronization (no more manual entry!)
- Detailed productivity insights to help you work smarter

If you're having any trouble logging in or have questions, we're here to help - just reach out to our friendly support team!

Warm regards,
The TimeTracker Team

---
You're receiving this because you have a JIRAForge account.
    `.trim(),
    
    /**
     * Generate HTML email body
     * @param {Object} data - Template data
     * @returns {string} HTML email body
     */
    html: ({ displayName, loginUrl, lastLoginDate }) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login Reminder</title>
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
            background: #0052CC;
            color: white !important;
            text-decoration: none;
            border-radius: 4px;
            font-weight: 500;
            margin: 20px 0;
        }
        .button:hover {
            background: #0747A6;
        }
        .features {
            background: #F4F5F7;
            padding: 20px;
            border-radius: 4px;
            margin: 20px 0;
        }
        .features ul {
            margin: 0;
            padding-left: 20px;
        }
        .features li {
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
        .last-login {
            background: #FFF3CD;
            border: 1px solid #FFECB5;
            padding: 12px 16px;
            border-radius: 4px;
            margin: 15px 0;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            <div class="logo">
                <h1>🚀 JIRAForge</h1>
            </div>
            
            <h2>Hello ${displayName}! 👋</h2>
            
            <p>I hope this message finds you well! We noticed it's been a little while since you've logged into JIRAForge Time Tracker, and we wanted to reach out.</p>
            
            ${lastLoginDate ? `<div class="last-login">📅 Your last visit was on <strong>${lastLoginDate}</strong></div>` : ''}
            
            <p>Whenever you're ready, we'd love to see you back! Login to continue tracking your work time:</p>
            
            <p style="text-align: center;">
                <a href="${loginUrl}" class="button">Login to JIRAForge</a>
            </p>
            
            <div class="features">
                <strong>Here's what's waiting for you:</strong>
                <ul>
                    <li>Automatic time tracking that links directly to your Jira issues</li>
                    <li>Easy worklog synchronization (no more manual entry!)</li>
                    <li>Detailed productivity insights to help you work smarter</li>
                </ul>
            </div>
            
            <p>Having any trouble logging in? No worries! Our friendly support team is here to help - just reach out anytime.</p>
            
            <p>Warm regards,<br><strong>The JIRAForge Team</strong></p>
            
            <div class="footer">
                <p>You're receiving this email because you have a JIRAForge account.</p>
            </div>
        </div>
    </div>
</body>
</html>
    `.trim()
};
