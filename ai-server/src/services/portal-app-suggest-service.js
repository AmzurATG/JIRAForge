/**
 * Portal App Suggest Service (AI-assisted "Add Application")
 *
 * Given a free-text application name (e.g. "Notion"), ask the existing AI
 * provider (Portkey/Fireworks via services/ai) to suggest whether it's a
 * desktop app, a website, or both, plus likely process name(s)/domain(s), a
 * clean display name, and a suggested classification.
 *
 * AI is ADVISORY only — the head/superadmin reviews and edits everything. The
 * function never throws to the caller: on any provider/parse failure it returns
 * null so the Add Application modal stays usable for manual entry.
 *
 * Gated by PORTAL_AI_APP_SUGGEST (off by default).
 */

'use strict';

const ai = require('./ai');
const logger = require('../utils/logger');

const VALID_KINDS = ['process', 'url'];
const VALID_CLASS = ['productive', 'non_productive', 'neutral'];
const MAX_LIST = 5;

/** Feature flag — AI suggestions only run when this is explicitly 'on'. */
function isEnabled() {
  return process.env.PORTAL_AI_APP_SUGGEST === 'on';
}

function buildMessages(name) {
  const system = [
    'You identify desktop/web applications for a workplace productivity tool.',
    'Given an application name, reply with STRICT JSON ONLY (no prose, no markdown fences) shaped exactly as:',
    '{',
    '  "displayName": string,            // clean human name, e.g. "Notion"',
    '  "kinds": string[],               // any of ["process","url"]: "process" if it has a desktop/exe app, "url" if it has a website',
    '  "processNames": string[],        // lowercase executable names, e.g. ["notion.exe"]; [] if none',
    '  "domains": string[],             // bare registrable domains, e.g. ["notion.so"]; [] if none',
    '  "suggestedClassification": "productive" | "non_productive" | "neutral",',
    '  "confidence": number,            // 0..1',
    '  "rationale": string              // one short sentence',
    '}',
    'Rules:',
    '- processNames are OS executable names only (e.g. slack.exe), lowercase, no paths.',
    '- domains are bare domains (e.g. slack.com): no scheme, no www, no path.',
    '- Include "process" in kinds only if a desktop/native app plausibly exists.',
    '- If the app is unknown to you, return empty arrays and confidence 0.',
    '- Default suggestedClassification to "neutral" unless the app is clearly work-productive or clearly distracting.',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Application name: ${name}` },
  ];
}

/** Coerce/validate the model's parsed object into our strict suggestion shape. */
function normalize(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const uniqClean = (arr, mapper) =>
    (Array.isArray(arr) ? arr : [])
      .map((v) => mapper(String(v)))
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, MAX_LIST);

  const processNames = uniqClean(obj.processNames, (s) => s.trim().toLowerCase());
  const domains = uniqClean(obj.domains, (s) =>
    s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0]
  );

  let kinds = uniqClean(obj.kinds, (s) => s.trim().toLowerCase()).filter((k) => VALID_KINDS.includes(k));
  if (!kinds.length) {
    if (processNames.length) kinds.push('process');
    if (domains.length) kinds.push('url');
  }

  const suggestedClassification = VALID_CLASS.includes(obj.suggestedClassification)
    ? obj.suggestedClassification
    : 'neutral';

  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    displayName: (obj.displayName ? String(obj.displayName).trim() : '').slice(0, 120),
    kinds,
    processNames,
    domains,
    suggestedClassification,
    confidence,
    rationale: (obj.rationale ? String(obj.rationale).trim() : '').slice(0, 280),
  };
}

/** Parse the model's text content into a suggestion object, or null. */
function safeParse(content) {
  if (!content || typeof content !== 'string') return null;
  let text = content.trim();

  // Strip ```json ... ``` fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  // Extract the outermost { ... } defensively.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    return null;
  }
  return normalize(parsed);
}

/**
 * Get AI suggestions for an app name. Returns the suggestion object, or null
 * (flag off, empty name, provider/parse failure). Never throws.
 */
async function suggestApp(name) {
  if (!isEnabled()) return null;
  const cleanName = (name == null ? '' : String(name)).trim().slice(0, 100);
  if (!cleanName) return null;

  try {
    const { response } = await ai.chatCompletionWithFallback({
      messages: buildMessages(cleanName),
      max_tokens: 400,
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    const content = response && response.choices && response.choices[0] && response.choices[0].message
      ? response.choices[0].message.content
      : null;
    return safeParse(content); // may be null on malformed output
  } catch (err) {
    logger.warn('[PortalAppSuggest] AI suggest failed', { error: err.message });
    return null; // advisory only — never surface to the user
  }
}

module.exports = { isEnabled, suggestApp, safeParse, normalize, buildMessages };
