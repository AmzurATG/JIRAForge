-- ============================================================================
-- Migration: Seed portal_app_catalog with product-provided default apps
-- Date: 2026-06-02
-- Feature: Web Productivity Portal — LOB segmentation & RBAC (Phase 1)
-- Spec: plan/2026-06-01_web-productivity-portal_lob-segmentation-rbac.md §7.2
--
-- Seeds a starter catalog (is_seed = true). default_classification is only a
-- suggested org-wide default; each LOB may override it. Re-runnable via
-- ON CONFLICT DO NOTHING. No per-LOB classifications are seeded.
-- ============================================================================

INSERT INTO public.portal_app_catalog (identifier, display_name, match_by, default_classification, is_seed)
VALUES
    -- Desktop apps (matched by process / executable)
    ('code.exe',        'Visual Studio Code',  'process', 'productive',     TRUE),
    ('idea64.exe',      'IntelliJ IDEA',        'process', 'productive',     TRUE),
    ('pycharm64.exe',   'PyCharm',              'process', 'productive',     TRUE),
    ('devenv.exe',      'Visual Studio',        'process', 'productive',     TRUE),
    ('windowsterminal.exe', 'Windows Terminal', 'process', 'productive',     TRUE),
    ('powershell.exe',  'PowerShell',           'process', 'productive',     TRUE),
    ('slack.exe',       'Slack',                'process', 'productive',     TRUE),
    ('teams.exe',       'Microsoft Teams',      'process', 'productive',     TRUE),
    ('ms-teams.exe',    'Microsoft Teams',      'process', 'productive',     TRUE),
    ('outlook.exe',     'Microsoft Outlook',    'process', 'productive',     TRUE),
    ('winword.exe',     'Microsoft Word',       'process', 'productive',     TRUE),
    ('excel.exe',       'Microsoft Excel',      'process', 'productive',     TRUE),
    ('powerpnt.exe',    'Microsoft PowerPoint', 'process', 'productive',     TRUE),
    ('postman.exe',     'Postman',              'process', 'productive',     TRUE),
    ('docker desktop.exe', 'Docker Desktop',    'process', 'productive',     TRUE),
    ('zoom.exe',        'Zoom',                 'process', 'productive',     TRUE),
    -- Browsers themselves are neutral; productivity depends on the site (url rules)
    ('chrome.exe',      'Google Chrome',        'process', 'neutral',        TRUE),
    ('msedge.exe',      'Microsoft Edge',       'process', 'neutral',        TRUE),
    ('firefox.exe',     'Mozilla Firefox',      'process', 'neutral',        TRUE),
    ('brave.exe',       'Brave Browser',        'process', 'neutral',        TRUE),
    ('explorer.exe',    'Windows Explorer',     'process', 'neutral',        TRUE),
    -- Web / SaaS apps (matched by site/domain)
    ('github',          'GitHub',               'url',     'productive',     TRUE),
    ('gitlab',          'GitLab',               'url',     'productive',     TRUE),
    ('atlassian',       'Jira / Confluence',    'url',     'productive',     TRUE),
    ('jira',            'Jira',                 'url',     'productive',     TRUE),
    ('stackoverflow',   'Stack Overflow',       'url',     'productive',     TRUE),
    ('figma',           'Figma',                'url',     'productive',     TRUE),
    ('chatgpt',         'ChatGPT',              'url',     'productive',     TRUE),
    ('docs.google',     'Google Docs',          'url',     'productive',     TRUE),
    ('office',          'Microsoft 365 (web)',  'url',     'productive',     TRUE),
    ('gmail',           'Gmail',                'url',     'neutral',        TRUE),
    ('youtube',         'YouTube',              'url',     'non_productive', TRUE),
    ('facebook',        'Facebook',             'url',     'non_productive', TRUE),
    ('instagram',       'Instagram',            'url',     'non_productive', TRUE),
    ('twitter',         'X (Twitter)',          'url',     'non_productive', TRUE),
    ('reddit',          'Reddit',               'url',     'non_productive', TRUE),
    ('netflix',         'Netflix',              'url',     'non_productive', TRUE),
    ('tiktok',          'TikTok',               'url',     'non_productive', TRUE)
ON CONFLICT (identifier, match_by) DO NOTHING;
