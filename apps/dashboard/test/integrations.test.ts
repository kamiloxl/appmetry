import { describe, expect, it } from 'vitest';
import {
  activationBlockers, errorText, eventLabel, mappingPayload, mappingProblem, newRow, sameMappings, sourceOptions, toRows,
} from '../src/lib/integrations';

describe('eventLabel', () => {
  it('names built-in events and leaves custom ones as typed', () => {
    expect(eventLabel('install')).toBe('Install');
    expect(eventLabel('rc_trial_converted')).toBe('Trial converted (RevenueCat)');
    expect(eventLabel('level_up')).toBe('level_up');
  });
});

describe('mappings editing', () => {
  const saved = [
    { source_event: 'install', target_event: 'MobileAppInstall', send_value: false, locked: true },
    { source_event: 'rc_trial_converted', target_event: 'Purchase', send_value: true, locked: false },
  ];

  it('accepts complete rows and reports the first problem otherwise', () => {
    const rows = toRows(saved);
    expect(mappingProblem(rows)).toBeNull();
    expect(mappingProblem([...rows, newRow()])).toBe('Choose an app event for every row.');
    expect(mappingProblem([...rows, { ...newRow(), source_event: 'level_up' }])).toBe('Choose a network event for level_up.');
    expect(mappingProblem([...rows, { ...newRow(), source_event: 'rc_trial_converted', target_event: 'Lead' }])).toBe('Trial converted (RevenueCat) is mapped twice.');
    expect(mappingProblem([...rows, { ...newRow(), source_event: 'x', target_event: 'bad/name' }])).toMatch(/not a valid event name/);
  });

  it('sends only unlocked rows, trimmed', () => {
    const rows = [...toRows(saved), { ...newRow(), source_event: ' level_up ', target_event: 'Lead ' }];
    expect(mappingPayload(rows)).toEqual([
      { source_event: 'rc_trial_converted', target_event: 'Purchase', send_value: true },
      { source_event: 'level_up', target_event: 'Lead', send_value: false },
    ]);
  });

  it('detects changes regardless of order', () => {
    expect(sameMappings(toRows([...saved].reverse()), saved)).toBe(true);
    const rows = toRows(saved);
    rows[1].send_value = false;
    expect(sameMappings(rows, saved)).toBe(false);
  });

  it('offers built-ins, custom events and the current value once', () => {
    expect(sourceOptions(['install', 'rc_trial_started'], ['level_up', 'install'], 'old_event')).toEqual(['install', 'rc_trial_started', 'level_up', 'old_event']);
    expect(sourceOptions(['install'], [], 'install')).toEqual(['install']);
  });
});

describe('activation and errors', () => {
  it('lists what blocks activation', () => {
    expect(activationBlockers({ keys_configured: false, dataset_id: null, has_token: false })).toEqual([
      'Server secret INTEGRATIONS_KEY', 'Dataset ID', 'Conversions API access token',
    ]);
    expect(activationBlockers({ keys_configured: true, dataset_id: '1', has_token: true })).toEqual([]);
  });
  it('explains known server errors', () => {
    expect(errorText('test_event_code_required')).toMatch(/test event code/);
    expect(errorText('something else')).toBe('something else');
  });
});

describe('oauthNotice', () => {
  it('turns the ?oauth= result into a banner', async () => {
    const { oauthNotice } = await import('../src/lib/integrations');
    expect(oauthNotice('connected')).toEqual({ ok: true, text: 'Connected to Facebook. Choose a dataset below.' });
    expect(oauthNotice('denied')?.ok).toBe(false);
    expect(oauthNotice(null)).toBeNull();
    expect(oauthNotice('weird')).toBeNull();
  });
});

describe('ad links', () => {
  it('appends the ad link slug to the in-app URL', async () => {
    const { adDeepLink } = await import('../src/lib/integrations');
    expect(adDeepLink('absapp://onboarding/abs', 'meta-1')).toBe('absapp://onboarding/abs?amt_l=meta-1');
    expect(adDeepLink('absapp://x?plan=6', 'meta-1')).toBe('absapp://x?plan=6&amt_l=meta-1');
    expect(adDeepLink('https://a.io/app?#/home', 'm')).toBe('https://a.io/app?amt_l=m#/home');
  });
  it('validates deep link URLs like the server', async () => {
    const { deepLinkProblem } = await import('../src/lib/integrations');
    expect(deepLinkProblem('absapp://onboarding')).toBeNull();
    expect(deepLinkProblem('')).toBeNull();
    expect(deepLinkProblem('javascript://alert(1)')).not.toBeNull();
    expect(deepLinkProblem('onboarding')).not.toBeNull();
  });
  it('Meta URL parameters use Meta macros and network-neutral names', async () => {
    const { META_URL_PARAMS } = await import('../src/lib/integrations');
    expect(META_URL_PARAMS).toContain('campaign_id={{campaign.id}}');
    expect(META_URL_PARAMS).toContain('utm_medium=paid_social');
  });
});
