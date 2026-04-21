/**
 * Approval Pending Digest Email Template
 *
 * Sent once per 24h (per user) while the user has AI-assigned time entries
 * sitting in `pending_approval`. Reminds them that the entries are blocked
 * from Jira sync until they review them in the "Needs Review" panel.
 */

module.exports = {
    type: 'approval_pending_digest',
    subject: ({ pendingCount }) =>
        `${pendingCount} time ${pendingCount === 1 ? 'entry needs' : 'entries need'} your review`,

    text: ({ displayName, pendingCount, oldestDate, totalHours, panelUrl, byDate }) => {
        const header = `Hi ${displayName || 'there'},\n\n`;
        const intro = `The AI has assigned time to ${pendingCount} work session${pendingCount === 1 ? '' : 's'} (${totalHours}) that need your review before they sync to Jira.\n\n`;
        const oldest = oldestDate ? `Oldest pending: ${oldestDate}\n\n` : '';
        const breakdown = Array.isArray(byDate) && byDate.length > 0
            ? 'Pending by date:\n' + byDate.map(d => `  - ${d.workDate}: ${d.count} session${d.count === 1 ? '' : 's'} (${d.totalHours})`).join('\n') + '\n\n'
            : '';
        const cta = `Review and approve here: ${panelUrl}\n\n`;
        const footer = `You're receiving this digest once per day while you have pending reviews.\nTo stop these emails, disable "Approval digest" in your notification settings.\n`;
        return header + intro + oldest + breakdown + cta + footer;
    },

    html: ({ displayName, pendingCount, oldestDate, totalHours, panelUrl, byDate }) => {
        const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const rows = Array.isArray(byDate)
            ? byDate.map(d => `
                <tr>
                  <td style="padding:8px 12px;border-bottom:1px solid #eee">${esc(d.workDate)}</td>
                  <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">${esc(d.count)} session${d.count === 1 ? '' : 's'}</td>
                  <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#666;text-align:right">${esc(d.totalHours)}</td>
                </tr>`).join('')
            : '';

        const tableBlock = rows
            ? `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">
                <thead>
                  <tr style="background:#f5f5f5">
                    <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Date</th>
                    <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #e5e7eb">Sessions</th>
                    <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #e5e7eb">Time</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>`
            : '';

        const plural = pendingCount === 1 ? '' : 's';

        return `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px">
  <div style="background:#fff8e6;border-left:4px solid #ff8b00;padding:16px 20px;border-radius:4px;margin-bottom:24px">
    <h2 style="margin:0;color:#a04800;font-size:18px">Time entries awaiting review</h2>
    <p style="margin:6px 0 0;color:#a04800;font-size:14px">${esc(pendingCount)} pending · ${esc(totalHours)}</p>
  </div>
  <p>Hi ${esc(displayName || 'there')},</p>
  <p>The AI has assigned time to <strong>${esc(pendingCount)} work session${plural}</strong> (${esc(totalHours)}) that ${plural === '' ? 'needs' : 'need'} your review before ${plural === '' ? 'it syncs' : 'they sync'} to Jira.</p>
  ${oldestDate ? `<p style="color:#666;font-size:14px">Oldest pending: <strong>${esc(oldestDate)}</strong></p>` : ''}
  ${tableBlock}
  <p style="margin-top:20px">
    <a href="${esc(panelUrl)}" style="display:inline-block;background:#6656fc;color:#fff;padding:10px 24px;text-decoration:none;border-radius:4px;font-weight:600">
      Review in Jira
    </a>
  </p>
  <p style="color:#666;font-size:13px;margin-top:28px">
    You're receiving this digest once per day while you have pending reviews.
    To stop these emails, disable "Approval digest" in your notification settings.
  </p>
</body>
</html>`;
    }
};
