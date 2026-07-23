'use client';

/**
 * UI preferences — theme, sider collapse, and the per-workspace test/live mode.
 * Persisted to localStorage; the URL still owns org/workspace scope (docs/10 §3).
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Mode } from '@/lib/contract';

export type ThemeMode = 'light' | 'dark';

interface UiState {
  theme: ThemeMode;
  siderCollapsed: boolean;
  /** Mode is per workspace — a live workspace must not go test because another did. */
  modeByWorkspace: Record<string, Mode>;
  /** Dismissible profile card (docs/11 §B) — never a blocker. */
  profileCardDismissed: boolean;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setSiderCollapsed: (collapsed: boolean) => void;
  setMode: (workspaceId: string, mode: Mode) => void;
  getMode: (workspaceId: string | undefined) => Mode;
  dismissProfileCard: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      theme: 'light',
      siderCollapsed: false,
      modeByWorkspace: {},
      profileCardDismissed: false,
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((s) => ({ theme: s.theme === 'light' ? 'dark' : 'light' })),
      setSiderCollapsed: (siderCollapsed) => set({ siderCollapsed }),
      setMode: (workspaceId, mode) =>
        set((s) => ({ modeByWorkspace: { ...s.modeByWorkspace, [workspaceId]: mode } })),
      // New workspaces start in test mode — you opt in to spending money.
      getMode: (workspaceId) => (workspaceId ? (get().modeByWorkspace[workspaceId] ?? 'test') : 'test'),
      dismissProfileCard: () => set({ profileCardDismissed: true }),
    }),
    { name: 'voiceai.ui' },
  ),
);
