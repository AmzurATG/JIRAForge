/**
 * Admin Inactivity Digest Email Template
 *
 * Sent to org owners/admins when one or more team members have been inactive
 * for longer than the configured threshold. Lists all affected members in a table.
 */

module.exports = {
    type: 'admin_inactivity_digest',
    subject: ({ orgName }) => `[TimeTracker] Just a heads up: ${orgName} team activity update`,

    text: ({ displayName, orgName, inactiveUsers }) => {
        const lines = inactiveUsers.map(u =>
            `  - ${u.name}: inactive for ${u.hoursInactive}h (last active: ${u.lastActivity})`
        ).join('\n');
        return `Hello ${displayName},\n\nI hope you're doing well! 😊\n\nWe wanted to gently let you know that a few team members in ${orgName} have been inactive for a while:\n\n${lines}\n\nWhen you have a moment, you might want to check in with them to see if they need any assistance.\n\nYou can review your team's activity anytime by logging into TimeTracker.\n`;
    },

    html: ({ displayName, orgName, inactiveUsers }) => {
        const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const rows = inactiveUsers.map(u => `
            <tr>
              <td style="padding:8px 12px;border-bottom:1px solid #eee">${esc(u.name)}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#d97706;font-weight:600">${esc(u.hoursInactive)}h inactive</td>
              <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#999;font-size:13px">${esc(u.lastActivity)}</td>
            </tr>`).join('');

        return `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px">
  <div style="background:#fff7ed;border-left:4px solid #f97316;padding:16px 20px;border-radius:4px;margin-bottom:24px">
    <h2 style="margin:0;color:#c2410c;font-size:18px">Team Activity Update 📊</h2>
    <p style="margin:6px 0 0;color:#92400e;font-size:14px">${esc(orgName)}</p>
  </div>
  <p>Hello ${esc(displayName)},</p>
  <p>I hope this finds you well! We wanted to kindly bring to your attention that a few team members in <strong>${esc(orgName)}</strong> have been less active recently. Perhaps they could use a friendly check-in:</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">
    <thead>
      <tr style="background:#f5f5f5">
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Member</th>
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Inactive For</th>
        <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Last Active</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="margin-top:20px;">If you'd like to check in with them or review team activity, feel free to reach out or log into TimeTracker at your convenience.</p>
  <p style="color:#666;font-size:13px;margin-top:24px">
    You're receiving this friendly update because you're an admin of <strong>${esc(orgName)}</strong> on TimeTracker.
  </p>
</body>
</html>`;
    }
};
