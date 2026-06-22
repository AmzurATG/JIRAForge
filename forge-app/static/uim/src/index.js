import { uiModificationsApi } from '@forge/jira-bridge';
import { invoke } from '@forge/bridge';

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

// ─── Format the indicator message ───
function formatIndicator(score, issues) {
  if (score >= 80) {
    return `✅ Description looks good (${score}/100)`;
  }
  const icon = score >= 50 ? '⚠️' : '🔴';
  const label = score >= 50 ? 'Needs work' : 'Poor quality';
  const bullets = (issues || []).slice(0, 3).map(i => `• ${i}`).join('\n');
  return `${icon} ${label} (${score}/100)\n${bullets}`;
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
  
  if (!description || description.trim().length < 5) {
    descField.setDescription('');
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
  
  try {
    // We are the latest keystroke!
    const title = summaryField?.getValue() || '';
    const issueType = typeField?.getValue();
    const typeName = issueType?.name || issueType?.value || 'Task';
    const projectKey = projectField?.getValue()?.key || 'UNKNOWN';

    // Show loading state and wait briefly so Jira applies the loading text
    // (Jira applies changes when the Promise returned by onChange resolves, 
    // but in this trick we await invoke, so the loading state might not flash immediately.
    // That's acceptable for standard LLM queries)
    
    console.log('UIM: Debounce finished, calling invoke...');
    const response = await invoke('analyzeDraftDescription', {
      title,
      description,
      issueType: typeName,
      projectKey
    });

    console.log('UIM: received response from invoke:', response);

    if (response && response.success) {
      const { score, issues } = response;
      const indicator = formatIndicator(score, issues);
      descField.setDescription(indicator);
    } else {
      descField.setDescription('⚠️ Analysis failed');
    }
  } catch (err) {
    console.error(err);
    descField.setDescription('⚠️ Error connecting to analysis service');
  }
}, () => ['description', 'summary', 'issuetype']);
