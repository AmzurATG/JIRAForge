'use strict';

const svc = require('../../src/services/portal-productivity-service');

const catalog = [
  { id: 'slack', identifier: 'slack.exe', match_by: 'process', default_classification: 'productive' },
  { id: 'yt', identifier: 'youtube', match_by: 'url', default_classification: 'non_productive' },
  { id: 'gh', identifier: 'github', match_by: 'url', default_classification: 'productive' },
];

describe('matchApp', () => {
  test('process app matches application_name exactly', () => {
    const app = svc.matchApp({ application_name: 'slack.exe' }, svc.buildCatalogIndex(catalog));
    expect(app.id).toBe('slack');
  });

  test('browser app matches site in window title', () => {
    const app = svc.matchApp(
      { application_name: 'chrome.exe', window_title: 'Funny clip - YouTube' },
      svc.buildCatalogIndex(catalog)
    );
    expect(app.id).toBe('yt');
  });

  test('unmatched activity returns null', () => {
    const app = svc.matchApp({ application_name: 'randomtool.exe', window_title: 'x' }, svc.buildCatalogIndex(catalog));
    expect(app).toBeNull();
  });
});

describe('computeProductivity — per-LOB rule → neutral (no catalog-default fallback)', () => {
  const rows = [
    { application_name: 'youtube', window_title: 'x - YouTube', duration_seconds: 3600 },
  ];

  test('an app uses its per-LOB rule; without a rule it is neutral (excluded), NOT the catalog default', () => {
    const withRule = svc.computeProductivity(rows, catalog, { yt: 'productive' });
    const noRule = svc.computeProductivity(rows, catalog, {}); // youtube default is non_productive — must be ignored

    expect(withRule.productivityPercentage).toBe(100);

    // No rule ⇒ neutral and excluded from the ratio, NOT counted as non_productive
    expect(noRule.nonProductiveHours).toBeCloseTo(0);
    expect(noRule.neutralHours).toBeCloseTo(1);
    expect(noRule.productivityPercentage).toBe(0); // denominator 0
  });

  test('unmatched AND unclassified apps both resolve to neutral and are excluded from the ratio', () => {
    const mixed = [
      { application_name: 'slack.exe', duration_seconds: 3600 }, // matched, catalog default productive — but no LOB rule ⇒ neutral
      { application_name: 'youtube', window_title: 'YouTube', duration_seconds: 3600 }, // matched, default non_productive — no rule ⇒ neutral
      { application_name: 'randomtool.exe', duration_seconds: 7200 }, // unmatched ⇒ neutral
    ];
    const result = svc.computeProductivity(mixed, catalog, {});

    expect(result.productiveHours).toBeCloseTo(0);
    expect(result.nonProductiveHours).toBeCloseTo(0);
    expect(result.neutralHours).toBeCloseTo(4); // 1 + 1 + 2, all neutral
    expect(result.productivityPercentage).toBe(0); // empty denominator
  });

  test('with explicit per-LOB rules, matched apps count; unmatched stays neutral', () => {
    const mixed = [
      { application_name: 'slack.exe', duration_seconds: 3600 },
      { application_name: 'youtube', window_title: 'YouTube', duration_seconds: 3600 },
      { application_name: 'randomtool.exe', duration_seconds: 7200 }, // unmatched ⇒ neutral
    ];
    const result = svc.computeProductivity(mixed, catalog, { slack: 'productive', yt: 'non_productive' });

    expect(result.productiveHours).toBeCloseTo(1);
    expect(result.nonProductiveHours).toBeCloseTo(1);
    expect(result.neutralHours).toBeCloseTo(2);
    expect(result.productivityPercentage).toBe(50);
  });

  test('catalog default_classification is NOT applied when the LOB has no rule', () => {
    const rowsGh = [{ application_name: 'github', window_title: 'repo - GitHub', duration_seconds: 1800 }];
    const result = svc.computeProductivity(rowsGh, catalog, {}); // github default is productive, but no rule
    expect(result.productiveHours).toBeCloseTo(0);
    expect(result.neutralHours).toBeCloseTo(0.5);
    expect(result.productivityPercentage).toBe(0);
  });

  test('accepts a Map for lob classifications', () => {
    const result = svc.computeProductivity(rows, catalog, new Map([['yt', 'productive']]));
    expect(result.productivityPercentage).toBe(100);
  });
});
