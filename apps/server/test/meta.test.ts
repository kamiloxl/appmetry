import { describe, expect, it } from 'vitest';
import { buildMetaEvent, meta, META_GRAPH_VERSION } from '../src/integrations/meta';
import type { OutboxEvent, PostbackInstall } from '../src/integrations/types';
import { sha256Hex } from '../src/lib/crypto';

const IDFA = '6D92078A-8246-4BA4-AE5B-76104861E7DC';
const install = (patch: Partial<PostbackInstall> = {}): PostbackInstall => ({
  id: 'inst-1', platform: 'ios', first_seen: 1_793_000_000_000, ad_consent: 1, att_status: 'authorized',
  device_extinfo: JSON.stringify({ modelId: 'iPhone16,1', w: 1179, h: 2556, density: 3 }),
  os_version: '18.1', app_version: '1.2.0', device_model: 'iPhone 15 Pro', locale: 'en-GB',
  source: 'Meta', channel: 'Paid', utm_source: 'meta', campaign_id: '120', adset_id: '121', ad_id: '122',
  fbclid: 'IwAR1', campaign_ids: 'ARFxyz', user_id: null, email: null, ...patch,
});
const event = (patch: Partial<OutboxEvent> = {}): OutboxEvent => ({
  id: 'ob-1', sourceEventId: 'rc_evt1', targetEvent: 'Purchase', eventTs: 1_793_000_123_456, valueCents: 5999, currency: 'USD',
  install: install(), bundleId: 'com.example.app', madid: IDFA, transient: { ip: '198.51.100.4', ua: 'App/1 CFNetwork' }, ...patch,
});

describe('Meta CAPI app event payload', () => {
  it('iOS, ATT authorized: ids, device, value and AEM campaign ids', async () => {
    const e = await buildMetaEvent(event(), {});
    expect(e).toEqual({
      event_name: 'Purchase',
      event_time: 1_793_000_123,
      event_id: 'rc_evt1',
      action_source: 'app',
      app_data: {
        advertiser_tracking_enabled: 1,
        application_tracking_enabled: 1,
        extinfo: ['i2', 'com.example.app', '1.2.0', '1.2.0', '18.1', 'iPhone16,1', 'en_GB', '', '', '1179', '2556', '3', '', '', '', ''],
        campaign_ids: 'ARFxyz',
      },
      user_data: { anon_id: 'inst-1', madid: IDFA, client_ip_address: '198.51.100.4', client_user_agent: 'App/1 CFNetwork' },
      custom_data: { value: 59.99, currency: 'USD' },
    });
  });

  it('iOS without ATT: advertiser_tracking_enabled 0 and no device identifiers', async () => {
    const e = await buildMetaEvent(event({ install: install({ att_status: 'denied' }), madid: IDFA, transient: { ip: '1.2.3.4', ua: 'x' } }), {});
    expect(e.app_data.advertiser_tracking_enabled).toBe(0);
    expect(e.user_data).toEqual({ anon_id: 'inst-1' });
    expect(e.app_data.campaign_ids).toBe('ARFxyz'); // AEM still works without ATT
  });

  it('Android: a2 extinfo, GAID, model name when there is no model id', async () => {
    const e = await buildMetaEvent(
      event({ install: install({ platform: 'android', att_status: null, device_extinfo: null, device_model: 'Pixel 8', locale: 'pl-PL' }), madid: 'gaid-1', bundleId: 'com.example.android' }),
      {},
    );
    expect(e.app_data.advertiser_tracking_enabled).toBe(1);
    expect(e.app_data.extinfo).toEqual(['a2', 'com.example.android', '1.2.0', '1.2.0', '18.1', 'Pixel 8', 'pl_PL', '', '', '', '', '', '', '', '', '']);
    expect(e.user_data.madid).toBe('gaid-1');
  });

  it('extinfo always has 16 string elements', async () => {
    const e = await buildMetaEvent(event({ install: null, bundleId: null }), {});
    expect(e.app_data.extinfo).toHaveLength(16);
    expect(e.app_data.extinfo.every((v) => typeof v === 'string')).toBe(true);
  });

  it('external_id is the hashed user id; email only when the integration shares it, normalised then hashed', async () => {
    const withUser = event({ install: install({ user_id: 'user-42', email: ' Jane.Doe@Example.com ' }) });
    const off = await buildMetaEvent(withUser, {});
    expect(off.user_data.external_id).toEqual([await sha256Hex('user-42')]);
    expect(off.user_data).not.toHaveProperty('em');
    const on = await buildMetaEvent(withUser, { share_hashed_email: true });
    expect(on.user_data.em).toEqual([await sha256Hex('jane.doe@example.com')]);
    expect(JSON.stringify(on)).not.toContain('Jane');
  });

  it('no value without a positive amount', async () => {
    expect(await buildMetaEvent(event({ valueCents: null, currency: null, targetEvent: 'MobileAppInstall' }), {})).not.toHaveProperty('custom_data');
  });

  it('request: dataset endpoint, token as query parameter, test event code', async () => {
    const req = await meta.buildRequest({ integrationId: 'i', token: 'TOK', config: { dataset_id: '1601828548167313', test_event_code: 'TEST42' } }, [event(), event({ id: 'ob-2' })]);
    expect(req.url).toBe(`https://graph.facebook.com/${META_GRAPH_VERSION}/1601828548167313/events?access_token=TOK`);
    const body = JSON.parse(String(req.init.body));
    expect(body.data).toHaveLength(2);
    expect(body.test_event_code).toBe('TEST42');
    expect(req.init.method).toBe('POST');
  });

  it('refuses a non-numeric dataset id', async () => {
    await expect(meta.buildRequest({ integrationId: 'i', token: 'T', config: { dataset_id: '../me' } }, [event()])).rejects.toThrow();
  });
});

describe('Meta response classification', () => {
  const err = (code: number, message = 'x', subcode?: number) => ({ error: { message, type: 'OAuthException', code, error_subcode: subcode, fbtrace_id: 'A1' } });
  it('2xx is sent', () => expect(meta.classify(200, { events_received: 2 }).outcome).toBe('sent'));
  it('expired or invalid token flags the integration', () => {
    expect(meta.classify(400, err(190, 'Error validating access token'))).toMatchObject({ outcome: 'fatal', integrationError: true });
  });
  it('missing permission flags the integration', () => {
    expect(meta.classify(403, err(200, 'Permissions error'))).toMatchObject({ outcome: 'fatal', integrationError: true });
  });
  it('rate limits and server errors retry', () => {
    for (const code of [4, 17, 32, 613]) expect(meta.classify(400, err(code)).outcome).toBe('retry');
    expect(meta.classify(500, null).outcome).toBe('retry');
    expect(meta.classify(429, null).outcome).toBe('retry');
  });
  it('invalid parameters fail with the message and trace id', () => {
    expect(meta.classify(400, err(100, 'Invalid parameter', 2804003))).toEqual({
      outcome: 'fatal', error: 'Meta 400 (code 100/2804003): Invalid parameter [fbtrace A1]',
    });
  });
});

describe('Meta adapter metadata', () => {
  it('maps the install to MobileAppInstall, locked', () => {
    expect(meta.defaultMappings.find((m) => m.source_event === 'install')).toEqual({
      source_event: 'install', target_event: 'MobileAppInstall', send_value: false, locked: true,
    });
  });
  it('attributed: Meta source, fbclid or AEM campaign ids', () => {
    expect(meta.isAttributedTo(install())).toBe(true);
    expect(meta.isAttributedTo(install({ source: 'Instagram', utm_source: null, fbclid: null, campaign_ids: null }))).toBe(true);
    expect(meta.isAttributedTo(install({ source: 'Google', utm_source: 'google', fbclid: null, campaign_ids: null }))).toBe(false);
  });
  it('needs a numeric dataset id', () => {
    expect(meta.missingConfig({})).toBe('dataset_id');
    expect(meta.missingConfig({ dataset_id: '1601828548167313' })).toBeNull();
    expect(meta.missingConfig({ dataset_id: '12a' })).toBe('dataset_id');
  });
});
