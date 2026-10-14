import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createJSONStorage,
  type PersistStorage,
  type StateStorage,
} from 'zustand/middleware';

export interface HydrationGatedStorage<S> {
  storage: PersistStorage<S>;
  markHydrated(): void;
  isHydrated(): boolean;
  waitForWrites(): Promise<void>;
}

/** Prevent boot-time defaults from replacing saved state before Zustand finishes hydration. */
export function createHydrationGatedStorage<S>(
  base: StateStorage = AsyncStorage,
  unchanged?: (previous: S, next: S) => boolean,
): HydrationGatedStorage<S> {
  let hydrated = false;
  // Last snapshot known to be stored: read at hydration or confirmed by a resolved write.
  let lastSaved: S | undefined;
  // Newest snapshot handed to storage whose write has not settled yet.
  let lastIssued: { state: S } | undefined;
  const pendingWrites = new Set<Promise<void>>();
  const json = createJSONStorage<S>(() => base);
  if (!json) throw new Error('JSON storage is unavailable');

  return {
    storage: {
      getItem: async name => {
        const value = await json.getItem(name);
        lastSaved = value?.state;
        return value;
      },
      setItem: (name, value) => {
        if (!hydrated) return undefined;
        const previous = lastIssued ? lastIssued.state : lastSaved;
        if (previous !== undefined && unchanged?.(previous, value.state)) {
          return undefined;
        }
        const issued = { state: value.state };
        lastIssued = issued;
        const settle = () => {
          if (lastIssued === issued) lastIssued = undefined;
        };
        const result = json.setItem(name, value);
        if (!result) {
          settle();
          lastSaved = value.state;
          return undefined;
        }
        const write = Promise.resolve(result).then(
          () => {
            settle();
            lastSaved = value.state;
          },
          error => {
            // Only a committed snapshot counts as saved, so the same content is written again later.
            settle();
            throw error;
          },
        );
        pendingWrites.add(write);
        return write.finally(() => pendingWrites.delete(write));
      },
      removeItem: name => {
        if (!hydrated) return undefined;
        lastIssued = undefined;
        lastSaved = undefined;
        return json.removeItem(name);
      },
    },
    markHydrated: () => {
      hydrated = true;
    },
    isHydrated: () => hydrated,
    waitForWrites: async () => {
      while (pendingWrites.size > 0) {
        await Promise.all([...pendingWrites]);
      }
    },
  };
}
