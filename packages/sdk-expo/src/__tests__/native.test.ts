import { collectAdSignals, collectInstallProps } from '../native';

const run = (module: any, os: string) => collectInstallProps({ module, os });

describe('collectInstallProps', () => {
  it('returns {} when native module missing', async () => {
    expect(await run(null, 'ios')).toEqual({});
  });

  it('maps android referrer seconds to ms', async () => {
    const module = {
      getInstallReferrer: jest.fn().mockResolvedValue({
        referrer: 'utm_source=google&utm_medium=cpc',
        clickTs: 1700000000.5,
        installTs: 1700000100,
      }),
    };
    expect(await run(module, 'android')).toEqual({
      referrer: 'utm_source=google&utm_medium=cpc',
      referrerClickTs: 1700000000500,
      installBeginTs: 1700000100000,
    });
  });

  it('drops zero/negative timestamps on android', async () => {
    const module = {
      getInstallReferrer: jest.fn().mockResolvedValue({ referrer: 'x', clickTs: 0, installTs: -1 }),
    };
    expect(await run(module, 'android')).toEqual({ referrer: 'x' });
  });

  it('returns {} when android referrer is null', async () => {
    expect(await run({ getInstallReferrer: jest.fn().mockResolvedValue(null) }, 'android')).toEqual({});
  });

  it('returns asaToken on ios', async () => {
    expect(await run({ getAdServicesToken: jest.fn().mockResolvedValue('tok123') }, 'ios')).toEqual({
      asaToken: 'tok123',
    });
  });

  it('returns {} when ios token is null', async () => {
    expect(await run({ getAdServicesToken: jest.fn().mockResolvedValue(null) }, 'ios')).toEqual({});
  });

  it('returns {} when the module lacks the platform method', async () => {
    expect(await run({}, 'ios')).toEqual({});
    expect(await run({}, 'android')).toEqual({});
  });

  it('returns {} on a non-mobile OS without calling native', async () => {
    const module = { getAdServicesToken: jest.fn(), getInstallReferrer: jest.fn() };
    expect(await run(module, 'web')).toEqual({});
    expect(module.getAdServicesToken).not.toHaveBeenCalled();
    expect(module.getInstallReferrer).not.toHaveBeenCalled();
  });

  it('omits empty-string token and referrer', async () => {
    expect(await run({ getAdServicesToken: jest.fn().mockResolvedValue('') }, 'ios')).toEqual({});
    const module = {
      getInstallReferrer: jest.fn().mockResolvedValue({ referrer: '', clickTs: 5, installTs: 6 }),
    };
    expect(await run(module, 'android')).toEqual({ referrerClickTs: 5000, installBeginTs: 6000 });
  });

  it('swallows async native errors (ios)', async () => {
    const module = { getAdServicesToken: jest.fn().mockRejectedValue(new Error('boom')) };
    expect(await run(module, 'ios')).toEqual({});
  });

  it('swallows synchronous native throws (android)', async () => {
    const module = {
      getInstallReferrer: jest.fn().mockImplementation(() => {
        throw new Error('sync boom');
      }),
    };
    expect(await run(module, 'android')).toEqual({});
  });
});

// The fakes implement only the methods under test.
const ads = (c: boolean, d: { module: any; os: string }) => collectAdSignals(c, d);

describe('collectAdSignals', () => {
  const IDFA = '6D92078A-8246-4BA4-AE5B-76104861E7DC';
  const ios = (att: string | null, id: string | null = IDFA) => ({
    getTrackingAuthorizationStatus: jest.fn().mockResolvedValue(att),
    getAdvertisingId: jest.fn().mockResolvedValue(id),
  });

  it('iOS with consent and ATT authorized: att and IDFA', async () => {
    expect(await ads(true, { module: ios('authorized'), os: 'ios' })).toEqual({ adConsent: true, att: 'authorized', madid: IDFA });
  });

  it('iOS without ATT authorization or without consent never reads the IDFA', async () => {
    const denied = ios('denied');
    expect(await ads(true, { module: denied, os: 'ios' })).toEqual({ adConsent: true, att: 'denied' });
    expect(denied.getAdvertisingId).not.toHaveBeenCalled();
    const noConsent = ios('authorized');
    expect(await ads(false, { module: noConsent, os: 'ios' })).toEqual({ adConsent: false, att: 'authorized' });
    expect(noConsent.getAdvertisingId).not.toHaveBeenCalled();
  });

  it('Android reads the GAID only with consent and drops the all-zero id', async () => {
    const gaid = '38400000-8cf0-11bd-b23e-10b96e40000d';
    const mod = { getAdvertisingId: jest.fn().mockResolvedValue(gaid) };
    expect(await ads(true, { module: mod, os: 'android' })).toEqual({ adConsent: true, madid: gaid });
    expect(await ads(false, { module: mod, os: 'android' })).toEqual({ adConsent: false });
    expect(mod.getAdvertisingId).toHaveBeenCalledTimes(1);
    const zero = { getAdvertisingId: jest.fn().mockResolvedValue('00000000-0000-0000-0000-000000000000') };
    expect(await ads(true, { module: zero, os: 'android' })).toEqual({ adConsent: true });
  });

  it('ignores unknown values, missing modules and native errors', async () => {
    expect(await ads(true, { module: ios('weird', 'not-an-id'), os: 'ios' })).toEqual({ adConsent: true });
    expect(await ads(true, { module: null as any, os: 'ios' })).toEqual({ adConsent: true });
    const failing = { getTrackingAuthorizationStatus: jest.fn().mockRejectedValue(new Error('x')) };
    expect(await ads(true, { module: failing, os: 'ios' })).toEqual({ adConsent: true });
  });
});
