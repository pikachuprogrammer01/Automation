import { ApiError } from './types';
import type { LogChunk, SystemInfo, Task } from './types';

/** 仅用于服务不可达时的文案；真实端口优先取 /api/system 返回值。 */
let knownPort = 4765;

export const currentPort = () => knownPort;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
  } catch {
    throw new ApiError('unreachable', `无法连接本地管理器（${knownPort} 端口当前没有服务）`);
  }
  const text = await res.text();
  let data: T & { ok?: boolean; error?: string };
  try {
    data = JSON.parse(text) as T & { ok?: boolean; error?: string };
  } catch {
    throw new ApiError('backend', `管理器返回了非 JSON 响应（HTTP ${res.status}）`);
  }
  if (!res.ok || !data.ok) {
    throw new ApiError(res.status >= 500 ? 'backend' : 'request', data.error || `HTTP ${res.status}`);
  }
  return data;
}

export const api = {
  tasks: (): Promise<{ tasks: Task[] }> => request('/api/tasks'),
  system: (): Promise<SystemInfo> => request<SystemInfo>('/api/system').then((s) => {
    if (typeof s.port === 'number') knownPort = s.port;
    return s;
  }),
  run: (id: string): Promise<{ pid: number }> => request(`/api/tasks/${id}/run`, { method: 'POST' }),
  enable: (id: string) => request(`/api/tasks/${id}/enable`, { method: 'POST' }),
  disable: (id: string) => request(`/api/tasks/${id}/disable`, { method: 'POST' }),
  schedule: (id: string, hour: number, minute: number) => request(`/api/tasks/${id}/schedule`, { method: 'POST', body: JSON.stringify({ hour, minute }) }),
  remove: (id: string) => request(`/api/tasks/${id}/remove`, { method: 'POST' }),
  purge: (id: string, body: { confirm: string; deleteCredential: boolean; deleteProfile: boolean; deleteLogs: boolean }) =>
    request(`/api/tasks/${id}/purge`, { method: 'POST', body: JSON.stringify(body) }),
  log: (id: string, from?: number): Promise<LogChunk> =>
    request<LogChunk>(`/api/tasks/${id}/log${typeof from === 'number' ? `?from=${from}` : ''}`),
  create: (body: { name: string; id: string; url: string; blank: boolean }) =>
    request('/api/recordings/create', { method: 'POST', body: JSON.stringify(body) }),
  recording: (id: string, action: 'login' | 'record' | 'open' | 'test'): Promise<{ pid?: number }> =>
    request(`/api/recordings/${id}/${action}`, { method: 'POST' }),
  shutdown: () => request('/api/system/shutdown', { method: 'POST' }),
};
