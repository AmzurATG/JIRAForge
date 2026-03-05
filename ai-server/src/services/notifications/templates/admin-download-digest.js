/**
 * Admin Download Digest Email Template
 *
 * Sent to org owners/admins when one or more team members have not yet
 * installed the JIRAForge Desktop App. Lists all affected members in a table.
 */

module.exports = {
    type: 'admin_download_digest',
    subject: ({ orgName }) => `[TimeTracker] Friendly reminder: Desktop App setup for ${orgName}`,

    text: ({ displayName, orgName, users, downloadUrl }) => {
        const lines = users.map(u => `  - ${u.name} (${u.email})`).join('\n');
        return `Hello ${displayName},\n\nI hope this message finds you well! 😊\n\nI wanted to reach out because we noticed that a few members of ${orgName} haven't had the chance to install the TimeTracker Desktop App yet:\n\n${lines}\n\nTo help them get started, feel free to share this download link: ${downloadUrl}\n\nIf they need any assistance with the installation, we're always here to help!\n`;
    },

    html: ({ displayName, orgName, users, downloadUrl }) => {
        const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const rows = users.map(u => `
            <tr>
              <td style="padding:8px 12px;border-bottom:1px solid #eee">${esc(u.name)}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#666;font-size:13px">${esc(u.email)}</td>
            </tr>`).join('');

        return `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px">
  <div style="background:#eff6ff;border-left:4px solid #3b82f6;padding:16px 20px;border-radius:4px;margin-bottom:24px">
    <h2 style="margin:0;color:#1d4ed8;font-size:18px">Desktop App Setup Reminder 😊</h2>
    <p style="margin:6px 0 0;color:#1e40af;font-size:14px">${esc(orgName)}</p>
  </div>
  <p>Hello ${esc(displayName)},</p>
  <p>I hope you're having a great day! We wanted to kindly let you know that a few members of <strong>${esc(orgName)}</strong> haven't had the opportunity to install the TimeTracker Desktop App yet:</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">
    <thead>
      <tr style="background:#f5f5f5">
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Member</th>
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Email</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p>Here's the download link you can share with them:</p>
  <p>
    <a href="${esc(downloadUrl)}" style="display:inline-block;background:#0052cc;color:#fff;padding:10px 24px;text-decoration:none;border-radius:4px;font-weight:600">
      Download TimeTracker Desktop App
    </a>
  </p>
  <p style="margin-top:20px;">If anyone needs help with the installation, please don't hesitate to reach out - we're always happy to assist!</p>
  <p style="color:#666;font-size:13px;margin-top:24px">
    You're receiving this friendly reminder because you're an admin of <strong>${esc(orgName)}</strong> on TimeTracker.
  </p>
</body>
</html>`;
    }
};
