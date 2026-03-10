/**
 * New Version Available Email Template
 * 
 * Sent to users when a new version of the desktop app is available.
 */

module.exports = {
    type: 'new_version',
    
    /**
     * Generate dynamic subject based on version
     * @param {Object} data - Template data
     * @returns {string} Email subject
     */
    subject: ({ version }) => `🎉 JIRAForge Desktop App v${version} is Available!`,
    
    /**
     * Generate plain text email body
     * @param {Object} data - Template data
     * @param {string} data.displayName - User's display name
     * @param {string} data.version - New version number
     * @param {string} data.currentVersion - User's current version
     * @param {string} data.releaseNotes - Release notes/changelog
     * @param {string} data.downloadUrl - URL to download the update
     * @param {boolean} [data.isMandatory] - Whether update is mandatory
     * @param {string} [data.settingsUrl] - URL to notification settings
     * @returns {string} Plain text email body
     */
    text: ({ displayName, version, currentVersion, releaseNotes, downloadUrl, isMandatory, settingsUrl }) => `
Hello ${displayName},

We're excited to share that a new version of the TimeTracker Desktop App is ready for you! 🎉

Current version: ${currentVersion}
New version: ${version}${isMandatory ? ' (Required Update)' : ''}

What's new and improved in v${version}:
${releaseNotes || '- Bug fixes and performance improvements'}

Ready to update? Download here: ${downloadUrl}

${isMandatory ? '⚠️ This is a required update to ensure everything works smoothly. Please update at your earliest convenience to continue enjoying TimeTracker.\n' : ''}
We recommend updating to enjoy the latest features, improvements, and security enhancements.

Warm regards,
The JIRAForge Team

---
You're receiving this because you have the JIRAForge Desktop App installed.
${settingsUrl ? `Manage your notification preferences: ${settingsUrl}` : 'You can manage your notification preferences in the app settings.'}
    `.trim(),
    
    /**
     * Generate HTML email body
     * @param {Object} data - Template data
     * @returns {string} HTML email body
     */
    html: ({ displayName, version, currentVersion, releaseNotes, downloadUrl, isMandatory, settingsUrl }) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>New Version Available</title>
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
        .version-box {
            background: #F4F5F7;
            padding: 20px;
            border-radius: 4px;
            margin: 20px 0;
            text-align: center;
        }
        .version-arrow {
            font-size: 24px;
            color: #00875A;
            margin: 0 15px;
        }
        .old-version {
            color: #666;
            text-decoration: line-through;
        }
        .new-version {
            background: #00875A;
            color: white;
            padding: 4px 12px;
            border-radius: 4px;
            font-weight: bold;
        }
        .release-notes {
            background: #DEEBFF;
            border: 1px solid #B3D4FF;
            padding: 20px;
            border-radius: 4px;
            margin: 20px 0;
        }
        .release-notes h4 {
            margin-top: 0;
            color: #0052CC;
        }
        .release-notes pre {
            margin: 0;
            white-space: pre-wrap;
            font-family: inherit;
        }
        .mandatory-warning {
            background: #FFEBE6;
            border: 1px solid #FF8F73;
            padding: 15px 20px;
            border-radius: 4px;
            margin: 20px 0;
            color: #BF2600;
        }
        .mandatory-warning strong {
            display: block;
            margin-bottom: 5px;
        }
        .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            color: #666;
            font-size: 12px;
            text-align: center;
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
            
            <p>We're excited to let you know that a new version of the JIRAForge Desktop App is ready for you!</p>
            
            <div class="version-box">
                <span class="old-version">${currentVersion}</span>
                <span class="version-arrow">→</span>
                <span class="new-version">${version}</span>
            </div>
            
            ${isMandatory ? `
            <div class="mandatory-warning">
                <strong>⚠️ Required Update</strong>
                To ensure everything continues to work smoothly, this update is required. Please update at your earliest convenience!
            </div>
            ` : ''}
            
            <div class="release-notes">
                <h4>📋 What's new and improved in v${version}:</h4>
                <pre>${releaseNotes || '• Bug fixes and performance improvements'}</pre>
            </div>
            
            <p style="text-align: center;">
                <a href="${downloadUrl}" class="button">⬇️ Download Update</a>
            </p>
            
            <p>We recommend updating to enjoy the latest features, improvements, and security enhancements!</p>
            
            <p>Warm regards,<br><strong>The JIRAForge Team</strong></p>
            
            <div class="footer">
                <p>You're receiving this email because you have the JIRAForge Desktop App installed.</p>
                ${settingsUrl ? `<p><a href="${settingsUrl}">Manage your notification preferences</a></p>` : '<p>You can manage your notification preferences in the app settings.</p>'}
            </div>
        </div>
    </div>
</body>
</html>
    `.trim()
};
