/**
 * The one place the dashboard talks to the network.
 *
 * Thin axios layer over `backend/control-plane` (http://localhost:3101). Request
 * and response shapes come from `contract.ts` — never invent a type here.
 */
import axios, { type AxiosInstance } from 'axios';
import type {
  Agent,
  ApiKey,
  Call,
  CallTrace,
  Invitation,
  Mode,
  Organization,
  OrgMembership,
  OverviewMetrics,
  Paginated,
  PlatformCapabilities,
  Session,
  Workspace,
} from '@/lib/contract';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3101';

const TOKEN_KEY = 'voiceai.token';

export const tokenStore = {
  get: () => (typeof window === 'undefined' ? null : window.localStorage.getItem(TOKEN_KEY)),
  set: (t: string) => window.localStorage.setItem(TOKEN_KEY, t),
  clear: () => window.localStorage.removeItem(TOKEN_KEY),
};

export const http: AxiosInstance = axios.create({
  baseURL: `${API_URL}/v1`,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
});

http.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/** Normalise every failure into an `ApiError` so screens render one error shape. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

http.interceptors.response.use(
  (res) => res,
  (error: unknown) => {
    if (axios.isAxiosError(error)) {
      const data = error.response?.data as { message?: string; code?: string } | undefined;
      if (error.response?.status === 401) tokenStore.clear();
      throw new ApiError(
        data?.message ??
          (error.code === 'ECONNABORTED' || error.code === 'ERR_NETWORK'
            ? 'Cannot reach the API. Is the control plane running on ' + API_URL + '?'
            : error.message),
        error.response?.status,
        data?.code,
      );
    }
    throw error;
  },
);

async function get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const res = await http.get<T>(path, { params });
  return res.data;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await http.post<T>(path, body);
  return res.data;
}

async function patch<T>(path: string, body?: unknown): Promise<T> {
  const res = await http.patch<T>(path, body);
  return res.data;
}

async function del<T>(path: string): Promise<T> {
  const res = await http.delete<T>(path);
  return res.data;
}

// ===========================================================================
// Auth
// ===========================================================================

export interface Credentials {
  email: string;
  password: string;
}

export const authApi = {
  signUp: (input: Credentials): Promise<{ needsVerification: boolean; email: string }> =>
    post('/auth/signup', input),

  async logIn(input: Credentials): Promise<{ token: string; session: Session }> {
    const out = await post<{ token: string; session: Session }>('/auth/login', input);
    tokenStore.set(out.token);
    return out;
  },

  /** 6-digit code, not a magic link — signup and inbox are often on different devices. */
  async verifyEmail(input: { email: string; code: string }): Promise<{ token: string; session: Session }> {
    const out = await post<{ token: string; session: Session }>('/auth/verify-email', input);
    tokenStore.set(out.token);
    return out;
  },

  resendCode: (email: string): Promise<void> => post('/auth/resend-code', { email }),

  requestPasswordReset: (email: string): Promise<void> => post('/auth/forgot-password', { email }),

  resetPassword: (input: { token: string; password: string }): Promise<void> =>
    post('/auth/reset-password', input),

  async logOut(): Promise<void> {
    try {
      await post('/auth/logout');
    } finally {
      tokenStore.clear();
    }
  },

  /** SSO — the backend owns the redirect. */
  ssoUrl: (provider: 'google' | 'microsoft'): string => `${API_URL}/v1/auth/sso/${provider}`,
};

// ===========================================================================
// Session & platform
// ===========================================================================

export const sessionApi = {
  get: (): Promise<Session> => get('/session'),
  setMode: (workspaceId: string, mode: Mode): Promise<void> =>
    patch(`/workspaces/${workspaceId}/mode`, { mode }),
};

export const platformApi = {
  capabilities: (): Promise<PlatformCapabilities> => get('/platform/capabilities'),
};

// ===========================================================================
// Orgs & workspaces
// ===========================================================================

export const orgApi = {
  list: (): Promise<Organization[]> => get('/orgs'),
  bySlug: (slug: string): Promise<Organization> => get(`/orgs/${slug}`),
  update: (id: string, body: Partial<Organization>): Promise<Organization> => patch(`/orgs/${id}`, body),
  members: (orgId: string): Promise<OrgMembership[]> => get(`/orgs/${orgId}/members`),
  invitations: (orgId: string): Promise<Invitation[]> => get(`/orgs/${orgId}/invitations`),
  invite: (orgId: string, body: Pick<Invitation, 'email' | 'role' | 'workspaceGrants'>): Promise<Invitation> =>
    post(`/orgs/${orgId}/invitations`, body),
  revokeInvite: (orgId: string, invitationId: string): Promise<void> =>
    del(`/orgs/${orgId}/invitations/${invitationId}`),
};

export const workspaceApi = {
  list: (orgId: string): Promise<Workspace[]> => get(`/orgs/${orgId}/workspaces`),
  bySlug: (orgSlug: string, slug: string): Promise<Workspace> =>
    get(`/orgs/${orgSlug}/workspaces/${slug}`),
  create: (orgId: string, body: Partial<Workspace>): Promise<Workspace> =>
    post(`/orgs/${orgId}/workspaces`, body),
  update: (id: string, body: Partial<Workspace>): Promise<Workspace> => patch(`/workspaces/${id}`, body),
  apiKeys: (workspaceId: string): Promise<ApiKey[]> => get(`/workspaces/${workspaceId}/keys`),
  /** The full secret comes back exactly once, here (docs/11 §9). */
  createApiKey: (workspaceId: string, body: { name: string; mode: Mode }): Promise<ApiKey> =>
    post(`/workspaces/${workspaceId}/keys`, body),
  revokeApiKey: (workspaceId: string, keyId: string): Promise<void> =>
    del(`/workspaces/${workspaceId}/keys/${keyId}`),
};

// ===========================================================================
// Agents, calls, overview
// ===========================================================================

export const agentApi = {
  list: (workspaceId: string): Promise<Agent[]> => get(`/workspaces/${workspaceId}/agents`),
  byId: (agentId: string): Promise<Agent> => get(`/agents/${agentId}`),
  create: (workspaceId: string, body: Partial<Agent>): Promise<Agent> =>
    post(`/workspaces/${workspaceId}/agents`, body),
  update: (agentId: string, body: Partial<Agent>): Promise<Agent> => patch(`/agents/${agentId}`, body),
  publish: (agentId: string, changeNote?: string): Promise<Agent> =>
    post(`/agents/${agentId}/publish`, { changeNote }),
};

export interface CallFilters {
  agentId?: string;
  outcome?: string;
  mode?: Mode;
  minLatencyMs?: number;
  search?: string;
  page?: number;
  pageSize?: number;
}

export const callApi = {
  list: (workspaceId: string, filters: CallFilters = {}): Promise<Paginated<Call>> =>
    get(`/workspaces/${workspaceId}/calls`, { ...filters }),
  byId: (callId: string): Promise<Call> => get(`/calls/${callId}`),
  trace: (callId: string): Promise<CallTrace> => get(`/calls/${callId}/trace`),
};

export const overviewApi = {
  get: (workspaceId: string): Promise<OverviewMetrics> => get(`/workspaces/${workspaceId}/overview`),
};
