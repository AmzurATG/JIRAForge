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

describe('computeProductivity — precedence & ratio', () => {
  const rows = [
    { application_name: 'youtube', window_title: 'x - YouTube', duration_seconds: 3600 },
  ];

  test('same app classified differently per LOB yields different productivity %', () => {
    const lobA = svc.computeProductivity(rows, catalog, { yt: 'productive' }); // LOB rule overrides default
    const lobB = svc.computeProductivity(rows, catalog, {}); // falls back to default non_productive

    expect(lobA.productivityPercentage).toBe(100);
    expect(lobB.productivityPercentage).toBe(0);
  });

  test('neutral and unmatched activity are excluded from the ratio', () => {
    const mixed = [
      { application_name: 'slack.exe', duration_seconds: 3600 }, // productive (default)
      { application_name: 'youtube', window_title: 'YouTube', duration_seconds: 3600 }, // non_productive (default)
      { application_name: 'randomtool.exe', duration_seconds: 7200 }, // unmatched → neutral
    ];
    const result = svc.computeProductivity(mixed, catalog, {});

    expect(result.productiveHours).toBeCloseTo(1);
    expect(result.nonProductiveHours).toBeCloseTo(1);
    expect(result.neutralHours).toBeCloseTo(2);
    // ratio uses only productive + non_productive (2h), not the neutral 2h
    expect(result.productivityPercentage).toBe(50);
  });

  test('catalog default applies when LOB has no rule', () => {
    const rowsGh = [{ application_name: 'github', window_title: 'repo - GitHub', duration_seconds: 1800 }];
    const result = svc.computeProductivity(rowsGh, catalog, {});
    expect(result.productiveHours).toBeCloseTo(0.5);
    expect(result.productivityPercentage).toBe(100);
  });

  test('accepts a Map for lob classifications', () => {
    const result = svc.computeProductivity(rows, catalog, new Map([['yt', 'productive']]));
    expect(result.productivityPercentage).toBe(100);
  });
});
