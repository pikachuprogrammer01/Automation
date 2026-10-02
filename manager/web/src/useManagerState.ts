import { App } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ApiError } from './types';
import type { Phase, SystemInfo, Task } from './types';

const CLOSED_KEY = 'automation-manager.closed-at';
const POLL_OK_MS = 5000;
const POLL_MAX_MS = 20000;
const POLL_CLOSED_PROBE_MS = 15000;
/** 主动关闭后服务进程退出的时间窗；这期间回来的响应不算“重启成功”。 */
const SHUTDOWN_GRACE_MS = 3000;

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 隐私模式下写入会抛，忽略即可 */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* 同上 */ } },
};
const markerAt = () => Number(store.get(CLOSED_KEY) || 0);
const markerAge = () => { const at = markerAt(); return at ? Date.now() - at : Infinity; };

export interface Snapshot {
  phase: Phase;
  tasks: Task[];
  system: SystemInfo | null;
  detail: string;
  lastSync: number | null;
}

export interface Controls {
  refresh: () => void;
  shutDown: () => void;
}

const EMPTY: Snapshot = { phase: 'ok', tasks: [], system: null, detail: '', lastSync: null };

/**
 * 轮询状态机：一次故障只提示一次，之后靠横幅；失败退避 5s→10s→20s 封顶；
 * 主动关闭与异常断连分开表述；页签隐藏时暂停、回前台立即刷新；轮询不叠加。
 */
export function useManagerState() {
  const { message, notification, modal } = App.useApp();
  const notify = useRef({ message, notification, modal });
  notify.current = { message, notification, modal };

  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [busy, setBusy] = useState({ refreshing: false, shuttingDown: false });
  const controls = useRef<Controls>({ refresh: () => {}, shutDown: () => {} });

  useEffect(() => {
    let alive = true;
    let timer = 0;
    let inFlight = false;
    let rerun = false;
    let failStreak = 0;
    let phase: Phase = 'ok';

    const apply = (patch: Partial<Snapshot>) => {
      if (alive) setSnap((prev) => ({ ...prev, ...patch }));
    };
    const enter = (next: Phase, why = '') => {
      phase = next;
      apply({ phase: next, detail: why });
    };
    const nextDelay = () => {
      if (phase === 'closed') return POLL_CLOSED_PROBE_MS;
      if (!failStreak) return POLL_OK_MS;
      return Math.min(POLL_OK_MS * 2 ** failStreak, POLL_MAX_MS);
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void poll(), nextDelay());
    };
    const shout = (text: string) => notify.current.message.error(text, 4);

    async function poll(manual = false) {
      if (!alive) return;
      if (inFlight) { rerun = true; return; }
      if (!manual && document.hidden) { schedule(); return; }
      inFlight = true;
      if (manual) setBusy((b) => ({ ...b, refreshing: true }));
      try {
        const [t, s] = await Promise.all([api.tasks(), api.system()]);
        if (s.manager !== 'running') throw new ApiError('backend', `${s.port} 端口上应答的不是自动化管理器`);
        if (markerAge() < SHUTDOWN_GRACE_MS) { enter('closed'); return; }
        failStreak = 0;
        store.del(CLOSED_KEY);
        apply({ tasks: t.tasks, system: s, lastSync: Date.now() });
        enter('ok');
      } catch (e) {
        const err = e as ApiError;
        if (err.kind === 'request') { shout(`刷新失败：${err.message}`); return; }
        failStreak += 1;
        // 一次故障只提示一次，之后由横幅和状态标签持续表达。
        const loud = manual || failStreak === 1;
        if (err.kind === 'unreachable' && markerAt()) {
          enter('closed');
        } else if (err.kind === 'backend') {
          enter('backend', err.message);
          if (loud) notify.current.notification.error({ message: '管理器接口异常', description: err.message, duration: 6 });
        } else {
          enter('lost', err.message);
          if (loud) shout(`刷新失败：${err.message}`);
        }
      } finally {
        inFlight = false;
        if (manual) setBusy((b) => ({ ...b, refreshing: false }));
        if (rerun) { rerun = false; await poll(false); return; }
        schedule();
      }
    }

    async function shutDown() {
      const { modal } = notify.current;
      modal.confirm({
        title: '关闭自动化管理器？',
        content: '只退出管理器本身，四个每日签到任务不受影响；服务退出后当前端口会立即释放。',
        okText: '确认关闭',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          // 先等在飞的轮询落地，否则关闭瞬间的响应会被误判成“管理器又活了”。
          for (let i = 0; i < 30 && inFlight; i += 1) await new Promise((r) => setTimeout(r, 100));
          store.set(CLOSED_KEY, String(Date.now()));
          failStreak = 0;
          setBusy((b) => ({ ...b, shuttingDown: true }));
          enter('closed');
          try {
            await api.shutdown();
            notify.current.message.success('管理器已关闭，端口已释放。每日签到任务不受影响。', 5);
          } catch (e) {
            const err = e as ApiError;
            if (err.kind !== 'unreachable') {
              store.del(CLOSED_KEY);
              enter('ok');
              notify.current.notification.error({ message: '关闭失败', description: err.message, duration: 8 });
              return;
            }
          } finally {
            setBusy((b) => ({ ...b, shuttingDown: false }));
          }
          schedule();
        },
      });
    }

    controls.current = { refresh: () => void poll(true), shutDown: () => void shutDown() };
    void poll();

    const onVisible = () => { if (!document.hidden) void poll(); };
    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== CLOSED_KEY) return;
      if (ev.newValue) { failStreak = 0; enter('closed'); schedule(); }
      else if (phase === 'closed') void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('storage', onStorage);

    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return { snap, busy, controls };
}
