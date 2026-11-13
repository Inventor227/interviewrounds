// REST client: one async function per route in docs/protocol.md.
// Same origin, cookies included (`ir_id` identifies the device or user).
// Every failure, including network errors, rejects with ApiError {status, code, message}.

import type {
  Catalog,
  CreateSessionReq,
  CreateSessionRes,
  EndReason,
  ErrorBody,
  HistoryItem,
  JoinPanelistRes,
  Me,
  MeetingSetup,
  PrepareMeetingRes,
  Report,
  Role,
  SessionStatusRes,
  Settings,
  ShareRes,
  Skills,
} from '../shared/types';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Full error body, e.g. `resets_at` for cap errors. */
    readonly body: ErrorBody = { code, message },
  ) {
    super(message);
  }
}

export const BOARD_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

type Body = { json: unknown } | { raw: Blob; type: string } | undefined;

async function request<T>(method: string, path: string, body?: Body): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (body && 'json' in body) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body.json);
  } else if (body) {
    headers['content-type'] = body.type;
    payload = body.raw;
  }

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'include' });
  } catch (err) {
    throw new ApiError(0, 'network', err instanceof Error ? err.message : 'Network error');
  }

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!res.ok) {
    const b = (data && typeof data === 'object' ? data : {}) as Partial<ErrorBody>;
    const code = typeof b.code === 'string' ? b.code : `http_${res.status}`;
    const message = typeof b.message === 'string' ? b.message : res.statusText || `HTTP ${res.status}`;
    throw new ApiError(res.status, code, message, { ...b, code, message });
  }
  return data as T;
}

const enc = encodeURIComponent;
const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, json?: unknown) => request<T>('POST', path, json === undefined ? undefined : { json });
const put = <T>(path: string, json: unknown) => request<T>('PUT', path, { json });
const del = <T>(path: string) => request<T>('DELETE', path);
const withRole = (path: string, role?: Role) => (role ? `${path}?role=${enc(role)}` : path);

export const api = {
  catalog: () => get<Catalog>('/api/content/catalog'),

  createSession: (req: CreateSessionReq) => post<CreateSessionRes>('/api/sessions', req),
  joinPanelist: (sessionId: string, panelistId: string, body: { opening_line?: string } = {}) =>
    post<JoinPanelistRes>(`/api/sessions/${enc(sessionId)}/panelists/${enc(panelistId)}/join`, body),
  resumeSession: (sessionId: string) => post<CreateSessionRes>(`/api/sessions/${enc(sessionId)}/resume`),
  endSession: (sessionId: string, reason: EndReason) =>
    post<void>(`/api/sessions/${enc(sessionId)}/end`, { reason }),
  sessionStatus: (sessionId: string) => get<SessionStatusRes>(`/api/sessions/${enc(sessionId)}`),
  report: (sessionId: string) => get<Report>(`/api/sessions/${enc(sessionId)}/report`),
  uploadBoardImage: async (sessionId: string, png: Blob): Promise<void> => {
    if (png.size > BOARD_IMAGE_MAX_BYTES) {
      throw new ApiError(413, 'too_large', 'Board image is larger than 2 MB');
    }
    return request<void>('POST', `/api/sessions/${enc(sessionId)}/board-image`, { raw: png, type: 'image/png' });
  },
  retry: (sessionId: string) => post<CreateSessionRes>(`/api/sessions/${enc(sessionId)}/retry`),

  me: () => get<Me>('/api/me'),
  history: (role?: Role) => get<HistoryItem[]>(withRole('/api/me/history', role)),
  skills: (role?: Role) => get<Skills>(withRole('/api/me/skills', role)),
  saveSettings: (settings: Settings) => put<void>('/api/me/settings', settings),
  onboardingDone: () => post<void>('/api/me/onboarding-done'),
  deleteMe: () => del<void>('/api/me'),

  prepareMeeting: (setup: MeetingSetup) => post<PrepareMeetingRes>('/api/meetings/prepare', setup),

  createShare: (sessionId: string, includeTranscript: boolean) =>
    post<ShareRes>('/api/shares', { session_id: sessionId, include_transcript: includeTranscript }),
  deleteShare: (slug: string) => del<void>(`/api/shares/${enc(slug)}`),

  logout: () => post<void>('/auth/logout'),
};

/** Full-page navigation targets (not fetch calls). */
export const links = {
  googleSignIn: '/auth/google/start',
  share: (slug: string) => `/s/${enc(slug)}`,
};

export type Api = typeof api;
