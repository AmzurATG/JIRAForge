/**
 * Default Password Reminder Email Template
 *
 * Sent to org admins every 30 days while the desktop admin panel
 * password is still set to the default value (admin123).
 * Friendly tone — a gentle nudge, not a nag.
 */

module.exports = {
    type: 'default_password_reminder',
    subject: ({ orgName }) => `[TimeTracker] Friendly reminder: Update your desktop admin password — ${orgName}`,

    text: ({ displayName, orgName }) =>
        `Hello ${displayName},\n\n` +
        `Just a quick heads-up! The desktop admin panel password for ${orgName} is still set to the factory default.\n\n` +
        `For better security, we recommend changing it to something unique. You can do this from your Jira project settings under the TimeTracker "Timesheet Settings" tab (org-level).\n\n` +
        `Once you save a new password, desktop apps will pick it up automatically within about 5 minutes — no restarts needed.\n\n` +
        `We'll send this reminder once every 30 days until the password is changed. No rush, just keeping it on your radar!\n\n` +
        `Thanks for keeping things secure.\n`,

    html: ({ displayName, orgName }) => {
        const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        return `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px">
  <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px 20px;border-radius:4px;margin-bottom:24px">
    <h2 style="margin:0;color:#92400e;font-size:18px">Desktop Admin Password Reminder</h2>
    <p style="margin:6px 0 0;color:#78350f;font-size:14px">${esc(orgName)}</p>
  </div>
  <p>Hello ${esc(displayName)},</p>
  <p>Just a quick heads-up! The desktop admin panel password for <strong>${esc(orgName)}</strong> is still set to the factory default.</p>
  <p>For better security, we recommend changing it to something unique. You can do this from your Jira project settings:</p>
  <ol style="line-height:1.8">
    <li>Open any project in Jira</li>
    <li>Go to <strong>TimeTracker &rarr; Timesheet Settings</strong></li>
    <li>Make sure no project is selected (org-level settings)</li>
    <li>Update the <strong>Desktop Admin Password</strong> field</li>
    <li>Click <strong>Save</strong></li>
  </ol>
  <p>Once saved, desktop apps will pick up the new password automatically within about 5 minutes &mdash; no restarts needed.</p>
  <p style="color:#666;font-size:13px;margin-top:24px">
    We send this friendly reminder once every 30 days until the password is changed. No rush &mdash; just keeping it on your radar!<br>
    You're receiving this because you're an admin of <strong>${esc(orgName)}</strong> on TimeTracker.
  </p>
</body>
</html>`;
    }
};
