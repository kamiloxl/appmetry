import { act, createElement } from 'react';
import { Text } from 'react-native';
import TestRenderer from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../client', () => ({ Appdash: { screen: jest.fn() } }));
// expo-router is not installed: requiring it throws.
jest.mock(
  'expo-router',
  () => {
    throw new Error("Cannot find module 'expo-router'");
  },
  { virtual: true }
);

import { Appdash } from '../client';
import { AppdashProvider } from '../provider';

it('provider without expo-router renders children', () => {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(createElement(AppdashProvider, null, createElement(Text, null, 'plain')));
  });
  const t = r.toJSON() as { type: string; children: string[] };
  expect(t.type).toBe('Text');
  expect(t.children).toEqual(['plain']);
  expect(Appdash.screen).not.toHaveBeenCalled();
});
