import AsyncStorage from '@react-native-async-storage/async-storage';

import { log } from './log';

export interface KV {
  get(k: string): Promise<string | null>;
  set(k: string, v: string): Promise<void>;
  remove(k: string): Promise<void>;
}

/**
 * AsyncStorage-backed key/value store. If any AsyncStorage call throws, the store
 * switches to an in-memory Map for the rest of the process, so callers never see errors.
 */
export function createStore(): KV {
  const memory = new Map<string, string>();
  let useMemory = false;

  async function run<T>(op: () => Promise<T>, fallback: () => T): Promise<T> {
    if (!useMemory) {
      try {
        return await op();
      } catch (err) {
        useMemory = true;
        log('AsyncStorage failed, keeping data in memory', err);
      }
    }
    return fallback();
  }

  return {
    get: (k) => run(() => AsyncStorage.getItem(k), () => memory.get(k) ?? null),
    set: (k, v) =>
      run(
        async () => {
          await AsyncStorage.setItem(k, v);
        },
        () => {
          memory.set(k, v);
        }
      ),
    remove: (k) =>
      run(
        async () => {
          await AsyncStorage.removeItem(k);
        },
        () => {
          memory.delete(k);
        }
      ),
  };
}
