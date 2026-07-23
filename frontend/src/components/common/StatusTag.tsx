'use client';

import { Tag, Tooltip } from 'antd';
import { createStyles } from 'antd-style';
import type { AgentStatus, CallOutcome, CallStatus, Mode, WorkspaceRole, OrgRole } from '@/lib/contract';

const useStyles = createStyles(({ token, css }) => ({
  tag: css`
    margin-inline-end: 0;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 550;
    line-height: 18px;
    padding-inline: 7px;
    border: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  `,
  dot: css`
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    flex: none;
  `,
  pulse: css`
    animation: livepulse 1.4s ease-in-out infinite;
    @keyframes livepulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.25;
      }
    }
  `,
  muted: css`
    color: ${token.colorTextTertiary};
    background: ${token.colorFillQuaternary};
  `,
}));

type Tone = 'success' | 'processing' | 'warning' | 'error' | 'default';

const AGENT_STATUS: Record<AgentStatus, { tone: Tone; label: string; hint: string }> = {
  live: { tone: 'success', label: 'Live', hint: 'Published and taking calls.' },
  draft: { tone: 'default', label: 'Draft', hint: 'Never published — test mode only.' },
  paused: { tone: 'warning', label: 'Paused', hint: 'Published but not accepting calls.' },
  archived: { tone: 'default', label: 'Archived', hint: 'Retired. Kept for its call history.' },
};

const CALL_STATUS: Record<CallStatus, { tone: Tone; label: string }> = {
  active: { tone: 'processing', label: 'In progress' },
  ringing: { tone: 'processing', label: 'Ringing' },
  completed: { tone: 'success', label: 'Completed' },
  failed: { tone: 'error', label: 'Failed' },
  no_answer: { tone: 'default', label: 'No answer' },
};

const OUTCOME: Record<CallOutcome, { tone: Tone; label: string }> = {
  resolved: { tone: 'success', label: 'Resolved' },
  escalated: { tone: 'warning', label: 'Escalated' },
  abandoned: { tone: 'error', label: 'Abandoned' },
  voicemail: { tone: 'default', label: 'Voicemail' },
  unknown: { tone: 'default', label: 'Unknown' },
};

const TONE_COLOR: Record<Tone, string | undefined> = {
  success: 'green',
  processing: 'blue',
  warning: 'orange',
  error: 'red',
  default: undefined,
};

function BaseTag({
  tone,
  label,
  hint,
  pulse,
}: {
  tone: Tone;
  label: string;
  hint?: string;
  pulse?: boolean;
}) {
  const { styles, cx } = useStyles();
  const tag = (
    <Tag
      className={cx(styles.tag, tone === 'default' && styles.muted)}
      color={TONE_COLOR[tone]}
      bordered={false}
    >
      <i className={cx(styles.dot, pulse && styles.pulse)} />
      {label}
    </Tag>
  );
  return hint ? <Tooltip title={hint}>{tag}</Tooltip> : tag;
}

export const AgentStatusTag = ({ status }: { status: AgentStatus }) => (
  <BaseTag {...AGENT_STATUS[status]} />
);

export const CallStatusTag = ({ status }: { status: CallStatus }) => (
  <BaseTag {...CALL_STATUS[status]} pulse={status === 'active' || status === 'ringing'} />
);

export const OutcomeTag = ({ outcome }: { outcome: CallOutcome }) => <BaseTag {...OUTCOME[outcome]} />;

export const ModeTag = ({ mode }: { mode: Mode }) => (
  <BaseTag
    tone={mode === 'live' ? 'success' : 'warning'}
    label={mode === 'live' ? 'Live' : 'Test'}
    hint={mode === 'live' ? 'Real telephony, real spend.' : 'Browser and test numbers only.'}
  />
);

const ROLE_LABEL: Record<OrgRole | WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  billing_admin: 'Billing admin',
  member: 'Member',
  workspace_admin: 'Workspace admin',
  developer: 'Developer',
  analyst: 'Analyst',
  viewer: 'Viewer',
};

export const RoleTag = ({ role }: { role: OrgRole | WorkspaceRole }) => (
  <BaseTag tone={role === 'owner' ? 'processing' : 'default'} label={ROLE_LABEL[role]} />
);
