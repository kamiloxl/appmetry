import { Platform } from 'react-native';

const mockModule: { current: any } = { current: null };
jest.mock('../AppdashAttributionModule', () => ({
  __esModule: true,
  get default() {
    return mockModule.current;
  },
}));

import { collectInstallProps } from '../native';

const setOS = (os: 'ios' | 'android') => {
  Object.defineProperty(Platform, 'OS', { get: () => os, configurable: true });
};

describe('collectInstallProps', () => {
  afterEach(() => {
    mockModule.current = null;
  });

  it('returns {} when native module missing', async () => {
    mockModule.current = null;
    setOS('ios');
    expect(await collectInstallProps()).toEqual({});
  });

  it('maps android referrer seconds to ms', async () => {
    setOS('android');
    mockModule.current = {
      getInstallReferrer: jest.fn().mockResolvedValue({
        referrer: 'utm_source=google&utm_medium=cpc',
        clickTs: 1700000000.5,
        installTs: 1700000100,
      }),
    };
    expect(await collectInstallProps()).toEqual({
      referrer: 'utm_source=google&utm_medium=cpc',
      referrerClickTs: 1700000000500,
      installBeginTs: 1700000100000,
    });
  });

  it('drops zero timestamps and null referrer on android', async () => {
    setOS('android');
    mockModule.current = {
      getInstallReferrer: jest.fn().mockResolvedValue({ referrer: 'x', clickTs: 0, installTs: -1 }),
    };
    expect(await collectInstallProps()).toEqual({ referrer: 'x' });
    mockModule.current = { getInstallReferrer: jest.fn().mockResolvedValue(null) };
    expect(await collectInstallProps()).toEqual({});
  });

  it('returns asaToken on ios', async () => {
    setOS('ios');
    mockModule.current = { getAdServicesToken: jest.fn().mockResolvedValue('tok123') };
    expect(await collectInstallProps()).toEqual({ asaToken: 'tok123' });
    mockModule.current = { getAdServicesToken: jest.fn().mockResolvedValue(null) };
    expect(await collectInstallProps()).toEqual({});
  });

  it('swallows native errors', async () => {
    setOS('ios');
    mockModule.current = { getAdServicesToken: jest.fn().mockRejectedValue(new Error('boom')) };
    expect(await collectInstallProps()).toEqual({});
    setOS('android');
    mockModule.current = {
      getInstallReferrer: jest.fn().mockImplementation(() => {
        throw new Error('sync boom');
      }),
    };
    expect(await collectInstallProps()).toEqual({});
  });
});
