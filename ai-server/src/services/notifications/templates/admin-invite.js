/**
 * Admin Invite Email Template
 * 
 * Sent to new admin users when their account is created.
 * Uses Google SSO - no password needed.
 */

module.exports = {
    type: 'admin_invite',
    
    subject: 'Welcome to the Productivity Portal - Admin Access Granted',
    
    /**
     * Generate plain text email body
     * @param {Object} data - Template data
     * @param {string} data.displayName - User's display name
     * @param {string} data.email - User's email
     * @param {string} data.role - User's role (superadmin, admin, viewer)
     * @param {string} data.portalUrl - URL to portal login
     * @param {string} [data.invitedBy] - Name of person who created the account
     * @returns {string} Plain text email body
     */
    text: ({ displayName, email, role, portalUrl, invitedBy }) => `
Hello ${displayName},

Welcome to the Productivity Portal! 🎉

${invitedBy ? `${invitedBy} has granted you admin access to the portal.` : 'You have been granted admin access to the portal.'}

Your Account Details:
- Email: ${email}
- Role: ${role}
- Access Level: ${role === 'superadmin' ? 'Full administrative access' : role === 'admin' ? 'Administrative access' : 'Read-only access'}

Getting Started:
1. Visit the portal: ${portalUrl}
2. Click "Sign in with Google"
3. Use your Google account (${email}) to sign in
4. You'll be automatically logged in - no password needed!

What You Can Do:
${role === 'superadmin' ? `- Manage all admin users and settings
- View and analyze employee productivity data
- Access all time logs and reports
- Configure portal settings` : role === 'admin' ? `- View and analyze employee productivity data
- Access time logs and reports
- Monitor team performance` : `- View employee productivity data
- Access reports (read-only)`}

Need Help?
If you have any questions or need assistance, please reach out to your administrator.

Best regards,
The Productivity Portal Team

---
You're receiving this because you were added as an admin user to the Productivity Portal.
    `.trim(),
    
    /**
     * Generate HTML email body
     * @param {Object} data - Template data
     * @returns {string} HTML email body
     */
    html: ({ displayName, email, role, portalUrl, invitedBy }) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Invite</title>
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
        .header {
            text-align: center;
            margin-bottom: 30px;
        }
        .header h1 {
            color: #1a73e8;
            margin: 0;
            font-size: 28px;
        }
        .welcome-icon {
            font-size: 48px;
            margin-bottom: 20px;
        }
        .section {
            margin: 25px 0;
        }
        .section h2 {
            color: #333;
            font-size: 18px;
            margin-bottom: 15px;
            border-bottom: 2px solid #f0f0f0;
            padding-bottom: 8px;
        }
        .info-box {
            background: #f8f9fa;
            border-left: 4px solid #1a73e8;
            padding: 15px;
            margin: 15px 0;
            border-radius: 4px;
        }
        .info-box p {
            margin: 8px 0;
        }
        .info-label {
            font-weight: 600;
            color: #555;
        }
        .button {
            display: inline-block;
            background: #1a73e8;
            color: white !important;
            padding: 14px 32px;
            text-decoration: none;
            border-radius: 6px;
            margin: 20px 0;
            font-weight: 600;
            text-align: center;
        }
        .button:hover {
            background: #1557b0;
        }
        .steps {
            counter-reset: step-counter;
            list-style: none;
            padding-left: 0;
        }
        .steps li {
            counter-increment: step-counter;
            margin: 15px 0;
            padding-left: 40px;
            position: relative;
        }
        .steps li::before {
            content: counter(step-counter);
            position: absolute;
            left: 0;
            top: 0;
            background: #1a73e8;
            color: white;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 14px;
        }
        .permissions {
            list-style: none;
            padding-left: 0;
        }
        .permissions li {
            padding: 8px 0 8px 28px;
            position: relative;
        }
        .permissions li::before {
            content: "✓";
            position: absolute;
            left: 0;
            color: #34a853;
            font-weight: bold;
            font-size: 18px;
        }
        .google-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            background: #fff;
            border: 1px solid #dadce0;
            border-radius: 4px;
            font-size: 14px;
            margin: 10px 0;
        }
        .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #e0e0e0;
            font-size: 12px;
            color: #666;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            <div class="header">
                <div class="welcome-icon">🎉</div>
                <h1>Welcome to the Productivity Portal!</h1>
            </div>
            
            <p>Hello <strong>${displayName}</strong>,</p>
            
            <p>${invitedBy ? `<strong>${invitedBy}</strong> has granted you admin access to the portal.` : 'You have been granted admin access to the portal.'}</p>
            
            <div class="section">
                <h2>Your Account Details</h2>
                <div class="info-box">
                    <p><span class="info-label">Email:</span> ${email}</p>
                    <p><span class="info-label">Role:</span> ${role}</p>
                    <p><span class="info-label">Access Level:</span> ${role === 'superadmin' ? 'Full administrative access' : role === 'admin' ? 'Administrative access' : 'Read-only access'}</p>
                </div>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
                <a href="${portalUrl}" class="button">Sign In with Google</a>
                <div class="google-badge">
                    <svg width="18" height="18" viewBox="0 0 24 24">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    <span>Secure Google Sign-On</span>
                </div>
            </div>
            
            <div class="section">
                <h2>Getting Started</h2>
                <ol class="steps">
                    <li>Visit the portal at <strong>${portalUrl}</strong></li>
                    <li>Click "Sign in with Google"</li>
                    <li>Use your Google account (<strong>${email}</strong>) to sign in</li>
                    <li>You'll be automatically logged in - no password needed!</li>
                </ol>
            </div>
            
            <div class="section">
                <h2>What You Can Do</h2>
                <ul class="permissions">
                    ${role === 'superadmin' ? `
                        <li>Manage all admin users and settings</li>
                        <li>View and analyze employee productivity data</li>
                        <li>Access all time logs and reports</li>
                        <li>Configure portal settings</li>
                    ` : role === 'admin' ? `
                        <li>View and analyze employee productivity data</li>
                        <li>Access time logs and reports</li>
                        <li>Monitor team performance</li>
                    ` : `
                        <li>View employee productivity data</li>
                        <li>Access reports (read-only)</li>
                    `}
                </ul>
            </div>
            
            <div class="footer">
                <p>Need help? Contact your administrator for assistance.</p>
                <p>You're receiving this because you were added as an admin user to the Productivity Portal.</p>
            </div>
        </div>
    </div>
</body>
</html>
    `.trim()
};
