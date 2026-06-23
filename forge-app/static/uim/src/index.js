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

// ─── Format the indicator message ───
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

// ─── Register onChange for description field ───
uiModificationsApi.onInit(({ api }) => {
  // No action on init
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
    descField.setDescription(`🛑 🛑 🛑\n${toBold('POOR QUALITY | Description Quality Score: 10/100')}\n  ➤ ${toBold('Description is too short. Please provide more details.')}`);
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