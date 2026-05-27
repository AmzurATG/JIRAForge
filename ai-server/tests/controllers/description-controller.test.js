'use strict';

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../src/services/description-service', () => ({
  analyzeDescription: jest.fn(),
  recordEvent: jest.fn()
}));

const descriptionService = require('../../src/services/description-service');
const controller = require('../../src/controllers/description-controller');

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(body = {}, ctx = { cloudId: 'cloud-1', accountId: 'acct-1' }) {
  return { body, forgeContext: ctx };
}

beforeEach(() => jest.clearAllMocks());

describe('description-controller.analyze validation', () => {
  const validBody = {
    issueKey: 'PROJ-123',
    title: 'A reasonable title',
    description: 'A reasonable description with enough detail',
    issueType: 'Bug',
    projectKey: 'PROJ'
  };

  test('accepts a fully valid body', async () => {
    descriptionService.analyzeDescription.mockResolvedValue({
      score: 80, source: 'deterministic', issues: [], suggestions: [],
      improved_title: null, improved_description: null, cached: false
    });
    const res = makeRes();
    await controller.analyze(makeReq(validBody), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ score: 80 })
    }));
  });

  test('rejects missing issueKey', async () => {
    const res = makeRes();
    await controller.analyze(makeReq({ ...validBody, issueKey: undefined }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects invalid issueKey format', async () => {
    const res = makeRes();
    await controller.analyze(makeReq({ ...validBody, issueKey: 'lowercase-1' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects invalid projectKey format', async () => {
    const res = makeRes();
    await controller.analyze(makeReq({ ...validBody, projectKey: '123BAD' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects invalid issueType', async () => {
    const res = makeRes();
    await controller.analyze(makeReq({ ...validBody, issueType: 'Wibble' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects oversize title', async () => {
    const res = makeRes();
    await controller.analyze(makeReq({ ...validBody, title: 'x'.repeat(501) }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects oversize description', async () => {
    const res = makeRes();
    await controller.analyze(makeReq({ ...validBody, description: 'x'.repeat(50001) }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('passes cloudId/accountId from forgeContext into service', async () => {
    descriptionService.analyzeDescription.mockResolvedValue({
      score: 70, source: 'llm', issues: [], suggestions: [],
      improved_title: 't', improved_description: 'd', cached: false
    });
    const res = makeRes();
    await controller.analyze(
      makeReq({ ...validBody, requestImprovement: true }, { cloudId: 'CID', accountId: 'AID' }),
      res
    );
    expect(descriptionService.analyzeDescription).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'CID', accountId: 'AID', requestImprovement: true })
    );
  });

  test('returns 500 when service throws', async () => {
    descriptionService.analyzeDescription.mockRejectedValue(new Error('boom'));
    const res = makeRes();
    await controller.analyze(makeReq(validBody), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('description-controller.recordEvent validation', () => {
  test('accepts a valid event payload', async () => {
    descriptionService.recordEvent.mockResolvedValue();
    const res = makeRes();
    await controller.recordEvent(makeReq({
      issueKey: 'PROJ-1',
      eventType: 'accept',
      scoreBefore: 40,
      scoreAfter: 85,
      source: 'llm'
    }), res);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  test('rejects unknown eventType', async () => {
    const res = makeRes();
    await controller.recordEvent(makeReq({ issueKey: 'PROJ-1', eventType: 'destroy' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects out-of-range scoreBefore', async () => {
    const res = makeRes();
    await controller.recordEvent(makeReq({ issueKey: 'PROJ-1', eventType: 'accept', scoreBefore: 999 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('swallows analytics errors (returns success)', async () => {
    descriptionService.recordEvent.mockRejectedValue(new Error('db down'));
    const res = makeRes();
    await controller.recordEvent(makeReq({ issueKey: 'PROJ-1', eventType: 'accept' }), res);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});
