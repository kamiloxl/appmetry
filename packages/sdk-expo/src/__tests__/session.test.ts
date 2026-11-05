import { SessionTracker } from '../session';

const FIVE_MIN = 5 * 60_000;
const make = () => {
  let n = 0;
  return new SessionTracker(FIVE_MIN, () => `session-${++n}-xxxxxxxx`);
};

describe('SessionTracker', () => {
  it('first active starts a session', () => {
    const t = make();
    expect(t.current()).toBeNull();
    const r = t.onActive(1000);
    expect(r.started).toBe(true);
    expect(t.current()).toBe(r.sid);
  });

  it('background then active within 5 min keeps sid', () => {
    const t = make();
    const a = t.onActive(0);
    t.onBackground(1000);
    const b = t.onActive(1000 + FIVE_MIN);
    expect(b).toEqual({ sid: a.sid, started: false });
  });

  it('after 5 min starts a new sid', () => {
    const t = make();
    const a = t.onActive(0);
    t.onBackground(1000);
    const b = t.onActive(1000 + FIVE_MIN + 1);
    expect(b.started).toBe(true);
    expect(b.sid).not.toBe(a.sid);
  });

  it('foregroundMs sums only active time', () => {
    const t = make();
    t.onActive(0);
    expect(t.onBackground(4000)?.foregroundMs).toBe(4000);
    t.onActive(100_000); // 96 s in the background do not count
    expect(t.onBackground(102_500)?.foregroundMs).toBe(2500);
  });

  it('onBackground without being active returns null', () => {
    const t = make();
    expect(t.onBackground(10)).toBeNull();
    t.onActive(0);
    t.onBackground(5);
    expect(t.onBackground(9)).toBeNull();
  });
});
