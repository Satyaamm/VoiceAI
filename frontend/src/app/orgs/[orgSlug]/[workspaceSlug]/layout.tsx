import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';

/** Every workspace-scoped screen renders inside the sider + header shell. */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
