import { uiModificationsApi } from '@forge/jira-bridge';
import { invoke, showFlag } from '@forge/bridge';

// ─── Lightweight ADF-to-text extractor ───
function adfToPlainText(adf) {
  if (!adf || typeof adf === 'string') return adf || '';
  if (typeof adf !== 'object') return '';

  let text = '';
  if (adf.type === 'text') {
    text += adf.text || '';
  }
  if (Array.isArray(adf.content)) {
    for (const child of adf.content) {
      text += adfToPlainText(child);
    }
  }
  // Add newlines for block-level nodes
  if (['paragraph', 'heading', 'listItem', 'blockquote'].includes(adf.type)) {
    text += '\n';
  }
  return text;
}

// ─── Unicode Bold Converter ───
const toBold = (str) => str.split('').map(c => {
  if (/[A-Z]/.test(c)) return String.fromCodePoint(c.charCodeAt(0) - 65 + 0x1D5D4);
  if (/[a-z]/.test(c)) return String.fromCodePoint(c.charCodeAt(0) - 97 + 0x1D5EE);
  if (/[0-9]/.test(c)) return String.fromCodePoint(c.charCodeAt(0) - 48 + 0x1D7E2);
  return c;
}).join('');

// ─── Format the indicator message (GIC / IssueView) ───
function formatIndicator(score, issues) {
  if (score >= 80) {
    return `🌟 🌟 🌟\n${toBold(`EXCELLENT QUALITY | Description Quality Score: ${score}/100`)}\n✨ ${toBold('Your description is well-detailed!')} ✨`;
  }
  
  const isPoor = score < 50;
  const icon = isPoor ? '🛑 🛑 🛑' : '⚠️ ⚠️ ⚠️';
  const label = isPoor ? 'POOR QUALITY' : 'NEEDS IMPROVEMENT';
  const bullets = (issues || []).slice(0, 3).map(i => `  ➤ ${toBold(i)}`).join('\n');
  
  return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${icon}
${toBold(`${label} | Description Quality Score: ${score}/100`)}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${toBold('Please address the following to improve your score:')}
${bullets}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

// ─── Format the transition-view warning (IssueTransition) ───
// Uses a softer, actionable format — the user is about to move the issue forward,
// so we want to nudge without blocking (unless score < 50, where we set required).
function formatTransitionWarning(score, issues) {
  if (score >= 80) {
    return `✅ ${toBold(`Description Quality Score: ${score}/100 — Excellent`)} ✨\nThis ticket is well-described. Good to transition!`;
  }

  const isPoor = score < 50;
  const icon = isPoor ? '🛑' : '⚠️';
  const urgency = isPoor
    ? `${toBold('POOR description quality detected!')} Jira transitions with poor descriptions make handoffs harder for your team.`
    : `${toBold('Description could be improved')} before moving this ticket forward.`;
  const top3 = (issues || []).slice(0, 3).map(i => `  • ${i}`).join('\n');
  const actionHint = isPoor
    ? `${toBold('Required:')} Please open the Time Analytics panel and use "Improve with AI" before transitioning.`
    : `Tip: Open the Time Analytics panel → "Improve with AI" to fix these quickly.`;

  return `${icon} DQ Score: ${toBold(`${score}/100`)} — ${isPoor ? 'Poor' : 'Needs Work'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${urgency}
${top3 ? `\nIssues found:\n${top3}` : ''}

${actionHint}`;
}

// ─── Register onChange for description field (GIC + IssueView) ───
uiModificationsApi.onInit(({ api }) => {
  // No action on init for GIC / IssueView
}, () => ['description', 'summary', 'issuetype']);

let pendingCount = 0;
let lastDescription = '';

uiModificationsApi.onChange(async ({ api }) => {
  const { getFieldById } = api;

  const descField = getFieldById('description');
  const summaryField = getFieldById('summary');
  const typeField = getFieldById('issuetype');
  const projectField = getFieldById('project');

  if (!descField) return;

  const rawValue = descField.getValue();
  const description = adfToPlainText(rawValue);

  // Ignore event if description hasn't changed
  if (description === lastDescription) {
    return;
  }
  lastDescription = description;

  if (!description || description.trim().length === 0) {
    descField.setDescription(`🛑 🛑 🛑\n${toBold('POOR QUALITY | Description Quality Score: 0/100')}\n  ➤ ${toBold('Description is completely empty. Please provide details before creating the ticket.')}`);
    return;
  }

  if (description.trim().length < 10) {
    descField.setDescription(`🛑 🛑 🛑\n${toBold('POOR QUALITY | Description Quality Score: 1/100')}\n  ➤ ${toBold('Description is too short. Please provide more details.')}`);
    return;
  }

  // Advance the pending counter for debounce
  pendingCount++;
  const currentCount = pendingCount;

  // Debounce delay
  await new Promise(resolve => setTimeout(resolve, 1500));

  // If user typed more during our delay, abort this specific execution
  if (currentCount !== pendingCount) {
    return;
  }

  // We are the latest keystroke!
  const title = summaryField?.getValue() || '';
  const issueType = typeField?.getValue();
  const typeName = issueType?.name || issueType?.value || 'Task';
  const projectKey = projectField?.getValue()?.key || 'UNKNOWN';

  // Show a toast flag while loading to inform the user
  const loadingFlag = showFlag({
    id: 'desc-scoring-loader',
    title: 'Calculating Score...',
    description: 'Analyzing your description quality, please wait.',
    type: 'info',
    isAutoDismiss: false
  });

  try {
    // Show loading state (this will only be applied if invoke is fast or Jira batches it, but we must await invoke to update the final UI)
    // Jira applies changes when the Promise returned by onChange resolves.
    
    // Call invoke asynchronously
    const response = await invoke('analyzeDraftDescription', {
      title,
      description,
      issueType: typeName,
      projectKey
    });

    if (currentCount !== pendingCount) {
      loadingFlag.close();
      return; // User kept typing, abort
    }
    
    if (response && response.success) {
      const { score, issues } = response;
      const indicator = formatIndicator(score, issues);
      descField.setDescription(indicator);
      
      // Determine flag appearance based on score
      let flagType = 'success';
      let flagTitle = 'Score Generated!';
      
      if (score < 50) {
        flagType = 'error';
        flagTitle = 'Poor Description Quality!';
      } else if (score < 80) {
        flagType = 'warning';
        flagTitle = 'Description Needs Improvement';
      }

      // Show success/warning/error flag
      showFlag({
        id: `desc-scoring-success-${Date.now()}`,
        title: flagTitle,
        description: `Your new Description Quality Score is ${score}/100.`,
        type: flagType,
        isAutoDismiss: true
      });
    } else {
      descField.setDescription('⚠️ ' + toBold('Analysis failed'));
    }
  } catch (err) {
    console.error(err);
    if (currentCount !== pendingCount) {
      loadingFlag.close();
      return;
    }
    descField.setDescription('⚠️ ' + toBold('Error connecting to analysis service'));
  } finally {
    loadingFlag.close();
  }
}, () => ['description', 'summary', 'issuetype']);

// ─────────────────────────────────────────────────────────────────
// IssueTransition view — DQ soft gate
//
// On the transition dialog (IssueTransition viewType), we run a
// one-time score fetch on init rather than debounced keystroke
// tracking. The description field hint is set to show the current
// score and quality issues. If score < 50, the description field is
// also marked required so Jira prevents the transition until the
// user acknowledges (edits the description) — a soft quality gate
// that works today without the preview workflowValidator module.
// ─────────────────────────────────────────────────────────────────

let transitionScoredIssueKey = null; // prevents redundant fetches on re-renders

uiModificationsApi.onInit(async ({ api, context }) => {
  // Only activate on IssueTransition views
  const viewType = context?.viewType;
  if (viewType !== 'IssueTransition') return;

  const { getFieldById } = api;
  const descField = getFieldById('description');
  if (!descField) return;

  // Extract issue key from context
  const issueKey = context?.issue?.key || context?.issueKey;
  if (!issueKey) return;

  // Skip redundant fetch if we already scored this issue in this session
  if (transitionScoredIssueKey === issueKey) return;
  transitionScoredIssueKey = issueKey;

  // Show a temporary "Checking..." hint while we fetch
  descField.setDescription(`⏳ ${toBold('Checking description quality before transition…')}`);

  try {
    const response = await invoke('analyzeDescription', {
      issueKey,
      requestImprovement: false
    });

    if (!response?.success) {
      // On failure, clear the hint and do nothing else — don't block the user
      descField.setDescription('');
      return;
    }

    const { score, issues } = response;
    const warning = formatTransitionWarning(score, issues);
    descField.setDescription(warning);

    // Soft gate: mark description required when quality is poor (<50)
    // This prevents the transition from completing until the user
    // edits the description field (acknowledging the warning).
    if (score < 50) {
      try {
        descField.setRequired(true);
      } catch {
        // setRequired may not be supported on all Jira versions — fail silently
      }

      // Show a persistent flag so the user understands why the button may be blocked
      showFlag({
        id: 'dq-transition-gate',
        title: '🛑 Poor Description Quality',
        description: `Score: ${score}/100. Please improve the description in the Time Analytics panel before transitioning.`,
        type: 'error',
        isAutoDismiss: false
      });
    } else if (score < 80) {
      showFlag({
        id: 'dq-transition-warn',
        title: '⚠️ Description Could Be Improved',
        description: `Score: ${score}/100. Consider improving via Time Analytics → "Improve with AI".`,
        type: 'warning',
        isAutoDismiss: true
      });
    }
  } catch (err) {
    console.error('[UIM IssueTransition] DQ fetch failed:', err);
    // Fail silently — never block the user on an error
    descField.setDescription('');
  }
}, () => ['description']);