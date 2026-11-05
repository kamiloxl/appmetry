import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SdkEvent } from '@appmetry/shared';

import { Queue } from '../queue';
import { createStore, type KV } from '../storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const KEY = 'appmetry:queue';

function ev(id: string): SdkEvent {
  return { id: `evt-${id}`.padEnd(8, '0'), type: 'event', name: 'tap', ts: 1_700_000_000_000, sid: 'session-1' };
}

const ids = (events: SdkEvent[]) => events.map((e) => e.id);

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('Queue', () => {
  test('queue persists and reloads', async () => {
    const q1 = new Queue(createStore());
    await q1.load();
    await q1.enqueue(ev('a'));
    await q1.enqueue(ev('b'));

    const raw = await AsyncStorage.getItem(KEY);
    expect(JSON.parse(raw as string)).toEqual([ev('a'), ev('b')]);

    const q2 = new Queue(createStore());
    await q2.load();
    expect(q2.size()).toBe(2);
    expect(q2.peek(10)).toEqual([ev('a'), ev('b')]);
  });

  test('queue drops oldest over cap', async () => {
    const q = new Queue(createStore(), 3);
    await q.load();
    for (const id of ['1', '2', '3', '4', '5']) await q.enqueue(ev(id));
    expect(q.size()).toBe(3);
    expect(ids(q.peek(10))).toEqual(ids([ev('3'), ev('4'), ev('5')]));

    const reloaded = new Queue(createStore(), 3);
    await reloaded.load();
    expect(ids(reloaded.peek(10))).toEqual(ids([ev('3'), ev('4'), ev('5')]));
  });

  test('default cap is 1000', async () => {
    const q = new Queue(createStore());
    await q.load();
    for (let i = 0; i < 1005; i++) void q.enqueue(ev(String(i)));
    await q.enqueue(ev('last'));
    expect(q.size()).toBe(1000);
    expect(q.peek(1)[0].id).toBe(ev('6').id);
  });

  test('ack removes only given ids', async () => {
    const q = new Queue(createStore());
    await q.load();
    for (const id of ['a', 'b', 'c', 'd']) await q.enqueue(ev(id));
    await q.ack([ev('b').id, ev('d').id, 'not-in-queue']);
    expect(ids(q.peek(10))).toEqual(ids([ev('a'), ev('c')]));

    const reloaded = new Queue(createStore());
    await reloaded.load();
    expect(ids(reloaded.peek(10))).toEqual(ids([ev('a'), ev('c')]));
  });

  test('peek returns at most n oldest events without removing them', async () => {
    const q = new Queue(createStore());
    await q.load();
    for (const id of ['a', 'b', 'c']) await q.enqueue(ev(id));
    expect(ids(q.peek(2))).toEqual(ids([ev('a'), ev('b')]));
    expect(q.peek(0)).toEqual([]);
    expect(q.size()).toBe(3);
  });

  test('concurrent enqueue calls never lose events', async () => {
    const q = new Queue(createStore());
    await q.load();
    await Promise.all(Array.from({ length: 30 }, (_, i) => q.enqueue(ev(String(i)))));
    expect(q.size()).toBe(30);

    const reloaded = new Queue(createStore());
    await reloaded.load();
    expect(reloaded.size()).toBe(30);
  });

  test('load tolerates corrupt JSON by starting empty', async () => {
    await AsyncStorage.setItem(KEY, '{not json');
    const q = new Queue(createStore());
    await expect(q.load()).resolves.toBeUndefined();
    expect(q.size()).toBe(0);

    await AsyncStorage.setItem(KEY, '{"not":"an array"}');
    const q2 = new Queue(createStore());
    await q2.load();
    expect(q2.size()).toBe(0);
  });

  test('load keeps events enqueued before it finished', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify([ev('old')]));
    const q = new Queue(createStore());
    const loading = q.load();
    await q.enqueue(ev('new'));
    await loading;
    expect(ids(q.peek(10))).toEqual(ids([ev('old'), ev('new')]));

    const reloaded = new Queue(createStore());
    await reloaded.load();
    expect(ids(reloaded.peek(10))).toEqual(ids([ev('old'), ev('new')]));
  });

  test('enqueue before load does not overwrite persisted events', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify([ev('old')]));
    const q = new Queue(createStore());
    await q.enqueue(ev('new'));
    await q.load();
    expect(ids(q.peek(10))).toEqual(ids([ev('old'), ev('new')]));
    const reloaded = new Queue(createStore());
    await reloaded.load();
    expect(ids(reloaded.peek(10))).toEqual(ids([ev('old'), ev('new')]));
  });

  test('clear during load does not restore cleared events', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify([ev('old')]));
    const q = new Queue(createStore());
    const loading = q.load();
    await q.clear();
    await loading;
    expect(q.size()).toBe(0);
    expect(await AsyncStorage.getItem(KEY)).toBeNull();
  });

  test('an unserializable event is refused and does not block later writes', async () => {
    const q = new Queue(createStore());
    await q.load();
    const props: Record<string, unknown> = {};
    props.self = props;
    await expect(q.enqueue({ ...ev('bad'), props })).resolves.toBeUndefined();
    await q.enqueue(ev('good'));
    expect(ids(q.peek(10))).toEqual(ids([ev('good')]));
    const reloaded = new Queue(createStore());
    await reloaded.load();
    expect(ids(reloaded.peek(10))).toEqual(ids([ev('good')]));
  });

  test('clear empties memory and storage', async () => {
    const q = new Queue(createStore());
    await q.load();
    await q.enqueue(ev('a'));
    await q.clear();
    expect(q.size()).toBe(0);
    const reloaded = new Queue(createStore());
    await reloaded.load();
    expect(reloaded.size()).toBe(0);
  });

  test('storage failures never throw and the queue keeps working in memory', async () => {
    const broken: KV = {
      get: () => Promise.reject(new Error('get')),
      set: () => Promise.reject(new Error('set')),
      remove: () => Promise.reject(new Error('remove')),
    };
    const q = new Queue(broken);
    await expect(q.load()).resolves.toBeUndefined();
    await expect(q.enqueue(ev('a'))).resolves.toBeUndefined();
    await expect(q.enqueue(ev('b'))).resolves.toBeUndefined();
    await expect(q.ack([ev('a').id])).resolves.toBeUndefined();
    expect(ids(q.peek(10))).toEqual(ids([ev('b')]));
    await expect(q.clear()).resolves.toBeUndefined();
    expect(q.size()).toBe(0);
  });
});

describe('createStore', () => {
  test('reads and writes AsyncStorage', async () => {
    const kv = createStore();
    await kv.set('k', 'v');
    expect(await AsyncStorage.getItem('k')).toBe('v');
    expect(await kv.get('k')).toBe('v');
    await kv.remove('k');
    expect(await kv.get('k')).toBeNull();
  });

  test('falls back to an in-memory Map when AsyncStorage throws', async () => {
    const spy = jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    const kv = createStore();
    await expect(kv.set('k', 'v')).resolves.toBeUndefined();
    expect(await kv.get('k')).toBe('v');
    await kv.remove('k');
    expect(await kv.get('k')).toBeNull();
    spy.mockRestore();
  });
});
