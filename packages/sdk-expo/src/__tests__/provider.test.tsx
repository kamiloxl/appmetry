import { act, createElement } from 'react';
import TestRenderer from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../client', () => ({ Appmetry: { screen: jest.fn() } }));

let mockPath = '/';
jest.mock('expo-router', () => ({ usePathname: () => mockPath }), { virtual: true });

import { Text } from 'react-native';

import { Appmetry } from '../client';
import { AppmetryProvider } from '../provider';

const screen = Appmetry.screen as jest.Mock;
beforeEach(() => {
  screen.mockClear();
  mockPath = '/';
});

const tree = (r: TestRenderer.ReactTestRenderer) => r.toJSON();
const el = (child = 'hello') => createElement(AppmetryProvider, null, createElement(Text, null, child));

describe('AppmetryProvider', () => {
  it('provider tracks pathname changes once per change', () => {
    mockPath = '/home';
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(el()); });
    expect(screen.mock.calls).toEqual([['/home']]);
    act(() => r.update(el('again'))); // same pathname: no new event
    expect(screen).toHaveBeenCalledTimes(1);
    mockPath = '/profile';
    act(() => r.update(el()));
    act(() => r.update(el()));
    expect(screen.mock.calls).toEqual([['/home'], ['/profile']]);
    mockPath = '/home';
    act(() => r.update(el()));
    expect(screen.mock.calls).toEqual([['/home'], ['/profile'], ['/home']]);
  });

  it('adds no wrapper element', () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(el('x')); });
    const t = tree(r) as { type: string; children: string[] };
    expect(t.type).toBe('Text');
    expect(t.children).toEqual(['x']);
  });
});
