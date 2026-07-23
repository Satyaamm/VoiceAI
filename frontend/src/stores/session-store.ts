'use client';

/**
 * Session slice — the signed-in user, their orgs/workspaces and effective
 * permissions. Async actions live in the store (docs/09 §Stack).
 *
 * Deliberately does NOT hold "current workspace": the URL owns scope
 * (docs/10 §Scoping rules 3). Components read slugs from the route and look the
 * entity up here.
 */
import { create } from 'zustand';
import { authApi, sessionApi, type Credentials } from '@/lib/api';
import type { Permission, Session } from '@/lib/contract';

interface SessionState {
  session: Session | null;
  status: 'idle' | 'loading' | 'authenticated' | 'anonymous';
  error: string | null;
  load: () => Promise<void>;
  logIn: (input: Credentials) => Promise<void>;
  verifyEmail: (input: { email: string; code: string }) => Promise<void>;
  logOut: () => Promise<void>;
  setSession: (session: Session) => void;
  /** Gate every action on a permission — never render a button that 403s. */
  can: (permission: Permission) => boolean;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  session: null,
  status: 'idle',
  error: null,

  load: async () => {
    set({ status: 'loading', error: null });
    try {
      const session = await sessionApi.get();
      set({ session, status: 'authenticated' });
    } catch (err) {
      set({ session: null, status: 'anonymous', error: (err as Error).message });
    }
  },

  logIn: async (input) => {
    set({ status: 'loading', error: null });
    try {
      const { session } = await authApi.logIn(input);
      set({ session, status: 'authenticated' });
    } catch (err) {
      set({ status: 'anonymous', error: (err as Error).message });
      throw err;
    }
  },

  verifyEmail: async (input) => {
    const { session } = await authApi.verifyEmail(input);
    set({ session, status: 'authenticated' });
  },

  logOut: async () => {
    await authApi.logOut();
    set({ session: null, status: 'anonymous' });
  },

  setSession: (session) => set({ session, status: 'authenticated' }),

  can: (permission) => get().session?.permissions.includes(permission) ?? false,
}));

/** Convenience selectors — keep component code free of optional chaining. */
export const useUser = () => useSessionStore((s) => s.session?.user ?? null);
export const useCan = () => useSessionStore((s) => s.can);
