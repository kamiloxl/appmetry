import { collectInstallProps } from '../native';

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
