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
</head>
<body style="margin:0;padding:0;background-color:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f6f9;padding:40px 0;">
        <tr>
            <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

                    <!-- Header Banner -->
                    <tr>
                        <td align="center" style="background:linear-gradient(135deg,#1a73e8 0%,#0d47a1 100%);border-radius:10px 10px 0 0;padding:40px 40px 35px;">
                            <div style="font-size:44px;margin-bottom:14px;">🎉</div>
                            <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">Welcome to the Productivity Portal</h1>
                            <p style="margin:10px 0 0;color:rgba(255,255,255,0.85);font-size:15px;">Your admin account is ready</p>
                        </td>
                    </tr>

                    <!-- Body -->
                    <tr>
                        <td style="background:#ffffff;padding:36px 40px;">

                            <p style="margin:0 0 6px;font-size:16px;color:#333;">Hello <strong>${displayName}</strong>,</p>
                            <p style="margin:0 0 28px;font-size:15px;color:#555;">
                                ${invitedBy ? `<strong>${invitedBy}</strong> has granted you admin access to the Productivity Portal.` : 'You have been granted admin access to the Productivity Portal.'}
                            </p>

                            <!-- Account Details -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                                <tr>
                                    <td style="border-left:4px solid #1a73e8;background:#f0f6ff;border-radius:0 6px 6px 0;padding:16px 20px;">
                                        <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#1a73e8;text-transform:uppercase;letter-spacing:0.5px;">Account Details</p>
                                        <table cellpadding="0" cellspacing="0" border="0">
                                            <tr>
                                                <td style="padding:3px 12px 3px 0;font-size:14px;color:#666;font-weight:600;">Email</td>
                                                <td style="padding:3px 0;font-size:14px;color:#333;">${email}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding:3px 12px 3px 0;font-size:14px;color:#666;font-weight:600;">Role</td>
                                                <td style="padding:3px 0;font-size:14px;color:#333;text-transform:capitalize;">${role}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding:3px 12px 3px 0;font-size:14px;color:#666;font-weight:600;">Access</td>
                                                <td style="padding:3px 0;font-size:14px;color:#333;">${role === 'superadmin' ? 'Full administrative access' : role === 'admin' ? 'Administrative access' : 'Read-only access'}</td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>

                            <!-- CTA Button -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:10px;">
                                <tr>
                                    <td align="center" style="padding:4px 0 16px;">
                                        <a href="${portalUrl}" style="display:inline-block;background:#1a73e8;color:#ffffff;text-decoration:none;padding:14px 44px;border-radius:6px;font-weight:700;font-size:16px;letter-spacing:0.2px;">Sign In with Google</a>
                                    </td>
                                </tr>
                                <tr>
                                    <td align="center" style="padding-bottom:28px;">
                                        <table cellpadding="0" cellspacing="0" border="0" style="display:inline-table;border:1px solid #dadce0;border-radius:4px;background:#fff;">
                                            <tr>
                                                <td style="padding:8px 16px;">
                                                    <table cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td style="padding-right:8px;vertical-align:middle;">
                                                                <svg width="18" height="18" viewBox="0 0 24 24" style="display:block;">
                                                                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                                                                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                                                                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                                                                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                                                                </svg>
                                                            </td>
                                                            <td style="font-size:13px;color:#444;vertical-align:middle;">Secure Google Sign-On</td>
                                                        </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>

                            <!-- Getting Started -->
                            <p style="margin:0 0 12px;font-size:15px;font-weight:700;color:#333;border-bottom:2px solid #f0f0f0;padding-bottom:8px;">Getting Started</p>
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
                                <tr>
                                    <td style="padding:6px 0;">
                                        <table cellpadding="0" cellspacing="0" border="0" width="100%">
                                            <tr>
                                                <td width="32" valign="top" style="padding-top:1px;"><span style="display:inline-block;width:24px;height:24px;background:#1a73e8;color:#fff;border-radius:50%;text-align:center;line-height:24px;font-size:13px;font-weight:700;">1</span></td>
                                                <td style="font-size:14px;color:#444;padding-left:4px;">Visit the portal: <a href="${portalUrl}" style="color:#1a73e8;text-decoration:none;font-weight:600;word-break:break-all;">${portalUrl}</a></td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding:6px 0;">
                                        <table cellpadding="0" cellspacing="0" border="0" width="100%">
                                            <tr>
                                                <td width="32" valign="top" style="padding-top:1px;"><span style="display:inline-block;width:24px;height:24px;background:#1a73e8;color:#fff;border-radius:50%;text-align:center;line-height:24px;font-size:13px;font-weight:700;">2</span></td>
                                                <td style="font-size:14px;color:#444;padding-left:4px;">Click <strong>&ldquo;Sign in with Google&rdquo;</strong></td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding:6px 0;">
                                        <table cellpadding="0" cellspacing="0" border="0" width="100%">
                                            <tr>
                                                <td width="32" valign="top" style="padding-top:1px;"><span style="display:inline-block;width:24px;height:24px;background:#1a73e8;color:#fff;border-radius:50%;text-align:center;line-height:24px;font-size:13px;font-weight:700;">3</span></td>
                                                <td style="font-size:14px;color:#444;padding-left:4px;">Use your Google account <strong>(${email})</strong> to sign in</td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding:6px 0;">
                                        <table cellpadding="0" cellspacing="0" border="0" width="100%">
                                            <tr>
                                                <td width="32" valign="top" style="padding-top:1px;"><span style="display:inline-block;width:24px;height:24px;background:#34a853;color:#fff;border-radius:50%;text-align:center;line-height:24px;font-size:13px;font-weight:700;">✓</span></td>
                                                <td style="font-size:14px;color:#444;padding-left:4px;">You&rsquo;ll be automatically logged in &mdash; no password needed!</td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>

                            <!-- What You Can Do -->
                            <p style="margin:0 0 12px;font-size:15px;font-weight:700;color:#333;border-bottom:2px solid #f0f0f0;padding-bottom:8px;">What You Can Do</p>
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:8px;">
                                ${role === 'superadmin' ? `
                                <tr><td style="padding:5px 0 5px 8px;font-size:14px;color:#444;"><span style="color:#34a853;font-weight:700;margin-right:8px;">&#10003;</span>Manage all admin users and settings</td></tr>
                                <tr><td style="padding:5px 0 5px 8px;font-size:14px;color:#444;"><span style="color:#34a853;font-weight:700;margin-right:8px;">&#10003;</span>View and analyze employee productivity data</td></tr>
                                <tr><td style="padding:5px 0 5px 8px;font-size:14px;color:#444;"><span style="color:#34a853;font-weight:700;margin-right:8px;">&#10003;</span>Access all time logs and reports</td></tr>
                                <tr><td style="padding:5px 0 5px 8px;font-size:14px;color:#444;"><span style="color:#34a853;font-weight:700;margin-right:8px;">&#10003;</span>Configure portal settings</td></tr>
                                ` : role === 'admin' ? `
                                <tr><td style="padding:5px 0 5px 8px;font-size:14px;color:#444;"><span style="color:#34a853;font-weight:700;margin-right:8px;">&#10003;</span>View and analyze employee productivity data</td></tr>
                                <tr><td style="padding:5px 0 5px 8px;font-size:14px;color:#444;"><span style="color:#34a853;font-weight:700;margin-right:8px;">&#10003;</span>Access time logs and reports</td></tr>
                                <tr><td style="padding:5px 0 5px 8px;font-size:14px;color:#444;"><span style="color:#34a853;font-weight:700;margin-right:8px;">&#10003;</span>Monitor team performance</td></tr>
                                ` : `
                                <tr><td style="padding:5px 0 5px 8px;font-size:14px;color:#444;"><span style="color:#34a853;font-weight:700;margin-right:8px;">&#10003;</span>View employee productivity data</td></tr>
                                <tr><td style="padding:5px 0 5px 8px;font-size:14px;color:#444;"><span style="color:#34a853;font-weight:700;margin-right:8px;">&#10003;</span>Access reports (read-only)</td></tr>
                                `}
                            </table>

                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td align="center" style="background:#f0f4f8;border-radius:0 0 10px 10px;padding:20px 40px;border-top:1px solid #e0e0e0;">
                            <p style="margin:0 0 4px;font-size:12px;color:#888;">Need help? Contact your administrator for assistance.</p>
                            <p style="margin:0;font-size:12px;color:#aaa;">You&rsquo;re receiving this because you were added as an admin user to the Productivity Portal.</p>
                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>
    `.trim()
};
