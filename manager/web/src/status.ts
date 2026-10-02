import { currentPort } from './api';
import type { Phase, Schedule, Task } from './types';

export interface PhaseMeta {
  label: string;
  color: string;
  alertType: 'error' | 'warning';
  heading: string;
  /** 横幅正文；detail 是后端/网络给出的具体原因。 */
  body: (detail: string) => string;
}

export function phaseMeta(phase: Phase): PhaseMeta {
  const port = currentPort();
  switch (phase) {
    case 'closed':
      return {
        label: '管理器已关闭',
        color: 'warning',
        alertType: 'warning',
        heading: '管理器已主动关闭',
        body: () => `已退出管理器并释放 ${port} 端口；每日签到任务不受影响。重新双击「自动化管理器.app」即可恢复，本页面会自动重连。`,
      };
    case 'lost':
      return {
        label: '连接中断',
        color: 'error',
        alertType: 'error',
        heading: '管理器连接已中断',
        body: (detail) => `下面显示的是最后一次成功加载的状态，正在退避重连（可点「刷新」立即重试）。${detail ? `原因：${detail}` : ''}`,
      };
    case 'backend':
      return {
        label: '后端异常',
        color: 'error',
        alertType: 'error',
        heading: '管理器接口异常',
        body: (detail) => `进程还在，但接口返回异常，任务状态可能不是最新。${detail ? `原因：${detail}` : ''}`,
      };
    default:
      return {
        label: '管理器运行中',
        color: 'success',
        alertType: 'error',
        heading: '',
        body: () => '',
      };
  }
}

export function scheduleText(s?: Schedule | null): string {
  if (!s || Number.isNaN(s.hour) || Number.isNaN(s.minute)) return '未设置';
  return `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
}

export type TaskState = { text: string; badge: 'success' | 'processing' | 'warning' | 'default' };

/** 后端给的 kind 已经是完整展示词（运行中 / 准备登录中 / 录制中 / 测试中），这里绝不能再叠一个“中”。 */
export function taskState(t: Task): TaskState {
  if (t.active) return { text: t.active.kind, badge: 'processing' };
  if (t.loaded) return { text: '已启用', badge: 'success' };
  if (t.plistExists) return { text: '已暂停', badge: 'warning' };
  return { text: '未启用', badge: 'default' };
}

export function elapsedText(startIso: string, endIso?: string): string {
  const a = Date.parse(startIso);
  const b = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(a) || Number.isNaN(b)) return '';
  const sec = Math.max(0, Math.round((b - a) / 1000));
  if (sec < 60) return `${sec} 秒`;
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}

export const pad = (n: number) => String(n).padStart(2, '0');

export function clockText(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function startedText(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : clockText(ms);
}
