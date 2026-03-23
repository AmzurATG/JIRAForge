/**
 * Inactivity Alert Email Template
 * 
 * Sent to users who haven't been active for a specified period during work hours.
 */

module.exports = {
    type: 'inactivity_alert',
    
    subject: '☕ Just checking in - TimeTracker',
    
    /**
     * Generate plain text email body
     * @param {Object} data - Template data
     * @param {string} data.displayName - User's display name
     * @param {string} data.lastActivityTime - Last activity timestamp
     * @param {number} data.hoursInactive - Hours since last activity
     * @returns {string} Plain text email body
     */
    text: ({ displayName, lastActivityTime, hoursInactive }) => `
Hello ${displayName},

I hope everything is going well! 😊

We noticed you haven't been active in TimeTracker for about ${hoursInactive}.

Last activity: ${lastActivityTime}

If you're enjoying a well-deserved break, that's wonderful! We just wanted to reach out in case you meant to be tracking your time.

If you'd like to resume tracking, simply open the Desktop App whenever you're ready - it will automatically pick up where you left off.

Warm regards,
The TimeTracker Team

---
You're receiving this friendly check-in because you have inactivity alerts enabled.
    `.trim(),
    
    /**
     * Generate HTML email body
     * @param {Object} data - Template data
     * @returns {string} HTML email body
     */
    html: ({ displayName, lastActivityTime, hoursInactive }) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Inactivity Alert</title>
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
        .alert-box {
            background: #FFF7E6;
            border: 1px solid #FFE7BA;
            padding: 20px;
            border-radius: 4px;
            margin: 20px 0;
            text-align: center;
        }
        .alert-box .time {
            font-size: 36px;
            font-weight: bold;
            color: #D46B08;
            margin-bottom: 5px;
        }
        .alert-box .label {
            color: #AD6800;
            font-size: 14px;
        }
        .last-activity {
            background: #F4F5F7;
            padding: 12px 16px;
            border-radius: 4px;
            margin: 15px 0;
            font-size: 14px;
            text-align: center;
        }
        .tips {
            background: #E3FCEF;
            border: 1px solid #ABF5D1;
            padding: 20px;
            border-radius: 4px;
            margin: 20px 0;
        }
        .tips h4 {
            margin-top: 0;
            color: #006644;
        }
        .tips ul {
            margin: 0;
            padding-left: 20px;
        }
        .tips li {
            margin: 8px 0;
        }
        .cta-text {
            background: #DEEBFF;
            border: 1px solid #B3D4FF;
            padding: 15px 20px;
            border-radius: 4px;
            margin: 20px 0;
            text-align: center;
        }
        .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            color: #666;
            font-size: 12px;
            text-align: center;
        }
        .footer a {
            color: #0052CC;
        }
        .reassurance {
            background: #E6FCFF;
            border: 1px solid #B3F5FF;
            padding: 15px 20px;
            border-radius: 4px;
            margin: 20px 0;
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
            
            <div class="alert-box">
                <div class="time">${hoursInactive}</div>
                <div class="label">since last activity</div>
            </div>
            
            <div class="last-activity">
                📅 Last activity: <strong>${lastActivityTime}</strong>
            </div>
            
            <div class="reassurance">
                <p style="margin: 0;">
                    ☕ <strong>Enjoying some time off?</strong> That's wonderful! We completely understand that breaks are essential. 
                    This is just a gentle check-in to make sure everything's okay.
                </p>
            </div>
            
            <div class="cta-text">
                <p style="margin: 0;">
                    If you meant to be tracking your work, no worries! Just open the Desktop App whenever you're ready.<br>
                    <strong>Your time tracking will automatically resume.</strong>
                </p>
            </div>
            
            <div class="tips">
                <h4>💡 Friendly reminders:</h4>
                <ul>
                    <li>The Desktop App automatically tracks your activity when running</li>
                    <li>Idle time is automatically detected and excluded - smart, right?</li>
                </ul>
            </div>
            
            <p>Warm regards,<br><strong>The TimeTracker Team</strong></p>
            
            <div class="footer">
                <p>You're receiving this friendly check-in because you have inactivity alerts enabled.</p>
            </div>
        </div>
    </div>
</body>
</html>
    `.trim()
};
