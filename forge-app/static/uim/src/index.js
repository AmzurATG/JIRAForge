import { uiModificationsApi } from '@forge/jira-bridge';

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

// ─── Rule-based scorer (ported from description-service.js) ───
const DESC_MIN = 50;
const TITLE_MIN = 10;
const TITLE_MAX = 80;

const PLACEHOLDER_PATTERNS = [/\bTODO\b/i, /\bTBD\b/i, /\bfill[\s-]?in\b/i,
  /\[placeholder\]/i, /\bXXX\b/, /\bFIXME\b/i];
const STEPS_PATTERNS = [/steps?\s+to\s+reproduce/i, /^\s*\d+[.)]\s+/m, /^\s*step\s*\d+/im];
const EXPECTED_ACTUAL = { expected: /\b(expected|should)\b/i, actual: /\b(actual|instead|happens|got)\b/i };
const ACCEPTANCE_PATTERNS = [/acceptance\s+criteria/i,
  /\bgiven\b[\s\S]{0,200}\bwhen\b[\s\S]{0,200}\bthen\b/i, /\bAC[:\s]/];
const ENV_PATTERNS = [/\b(windows|macos|linux|ios|android)\b/i,
  /\b(chrome|firefox|safari|edge)\b/i, /\bversion\s*[:=]?\s*\d/i,
  /\bv\d+\.\d+/i, /\benvironment\b/i, /\b(staging|production|prod|dev|qa)\b/i];
const ACTION_VERBS = [/\b(implement|add|fix|update|create|remove|refactor|investigate|verify|enable|disable|deploy|migrate|build|configure|integrate|design|test)\b/i];
const GENERIC_TITLES = new Set(['bug','issue','problem','error','task','todo',
  'fix','update','change','thing','something']);

function quickScore(title, description, issueTypeName) {
  const checks = [];
  
  // Title checks
  const tLen = (title || '').trim().length;
  checks.push({ pass: tLen >= TITLE_MIN && tLen <= TITLE_MAX,
    issue: 'Title too short or too long' });
  
  const words = (title||'').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const isGeneric = words.length <= 2 && words.every(w => GENERIC_TITLES.has(w));
  checks.push({ pass: !isGeneric, issue: 'Title is too generic' });
  
  // Description checks
  const dLen = (description || '').trim().length;
  checks.push({ pass: dLen >= DESC_MIN,
    issue: `Description too short (${dLen} chars, need ${DESC_MIN}+)` });
  
  const text = `${title||''}\n${description||''}`;
  checks.push({ pass: !PLACEHOLDER_PATTERNS.some(r => r.test(text)),
    issue: 'Contains placeholder text (TODO, TBD, etc.)' });
  checks.push({ pass: ACTION_VERBS.some(r => r.test(text)),
    issue: 'No clear action verb found' });
  
  // Type-specific checks
  const typeName = (issueTypeName || '').toLowerCase();
  if (typeName === 'bug') {
    checks.push({ pass: STEPS_PATTERNS.some(r => r.test(description||'')),
      issue: 'Missing steps to reproduce' });
    checks.push({ pass: EXPECTED_ACTUAL.expected.test(description||'') &&
      EXPECTED_ACTUAL.actual.test(description||''),
      issue: 'Missing expected/actual behavior' });
  }
  if (typeName === 'story') {
    checks.push({ pass: ACCEPTANCE_PATTERNS.some(r => r.test(description||'')),
      issue: 'Missing acceptance criteria' });
  }
  
  const passed = checks.filter(c => c.pass).length;
  const score = Math.round((passed / checks.length) * 100);
  const issues = checks.filter(c => !c.pass).map(c => c.issue);
  
  return { score, issues };
}

// ─── Format the indicator message ───
function formatIndicator(score, issues) {
  if (score >= 80) {
    return `✅ Description looks good (${score}/100)`;
  }
  const icon = score >= 50 ? '⚠️' : '🔴';
  const label = score >= 50 ? 'Needs work' : 'Poor quality';
  const bullets = issues.slice(0, 3).map(i => `• ${i}`).join('\n');
  return `${icon} ${label} (${score}/100)\n${bullets}`;
}

// ─── Register onChange for description field ───
uiModificationsApi.onInit(({ api }) => {
  // No action on init — just let the form load normally
}, () => ['description', 'summary', 'issuetype']);

uiModificationsApi.onChange(({ api, change }) => {
  const { getFieldById } = api;
  
  const descField = getFieldById('description');
  const summaryField = getFieldById('summary');
  const typeField = getFieldById('issuetype');
  
  if (!descField) return;
  
  const rawValue = descField.getValue();
  const description = adfToPlainText(rawValue);
  const title = summaryField?.getValue() || '';
  const issueType = typeField?.getValue();
  const typeName = issueType?.name || issueType?.value || 'Task';
  
  // Only score if there's some description content
  if (!description || description.trim().length < 5) {
    descField.setDescription('');  // clear any previous indicator
    return;
  }
  
  const { score, issues } = quickScore(title, description, typeName);
  const indicator = formatIndicator(score, issues);
  
  // Show the indicator as helper text below the description field
  descField.setDescription(indicator);
}, () => ['description', 'summary', 'issuetype']);
