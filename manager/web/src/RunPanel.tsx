import { App, Alert, Badge, Button, Descriptions, Drawer, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { clockText, elapsedText } from './status';
import type { Task } from './types';

interface Props {
  task: Task | null;
  onClose: () => void;
}

/** 每个进程号只提示一次；关掉面板再回看不应该重复弹。 */
const announced = new Set<string>();

/** 运行面板：点「立即运行」后直接把这次运行的输出摊开给你看，跑完给出成功/失败和退出码。 */
export default function RunPanel({ task, onClose }: Props) {
  const { message } = App.useApp();
  const [text, setText] = useState('');
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  const fromRef = useRef<number | null>(null);
  const boxRef = useRef<HTMLPreElement>(null);

  const running = Boolean(task?.active);
  const result = task?.lastRun ?? null;

  const pull = async (reset: boolean) => {
    if (!task) return;
    setLoading(true);
    try {
      if (reset) fromRef.current = task.active?.logStart ?? task.lastRun?.logStart ?? null;
      const chunk = await api.log(task.id, fromRef.current ?? undefined);
      setMissing(Boolean(chunk.missing));
      fromRef.current = chunk.size;
      setText((prev) => (chunk.text ? (reset ? chunk.text : prev + chunk.text) : (reset ? '' : prev)));
    } catch {
      /* 拉不到日志不打断：连接状态由主轮询统一提示 */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!task) return;
    setText('');
    void pull(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);

  useEffect(() => {
    if (!task) return;
    const iv = window.setInterval(() => void pull(false), running ? 1500 : 5000);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, running]);

  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [text]);

  useEffect(() => {
    if (!task || !result) return;
    const key = `${task.id}:${result.pid}`;
    if (announced.has(key)) return;
    announced.add(key);
    if (result.ok) message.success(`${task.name} 运行成功，用时 ${elapsedText(result.startedAt, result.endedAt)}`, 6);
    else message.error(`${task.name} 运行失败（退出码 ${result.code ?? '未知'}），面板里有完整输出`, 9);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.pid, result?.ok, task?.id]);

  const startIso = task?.active?.startedAt ?? task?.lastRun?.startedAt ?? null;

  const status = running
    ? <Badge status="processing" text={task?.active?.kind ?? '运行中'} />
    : result
      ? (result.ok
        ? <Badge status="success" text={`成功 · 用时 ${elapsedText(result.startedAt, result.endedAt)}`} />
        : <Badge status="error" text={`失败 · 退出码 ${result.code ?? '未知'} · 用时 ${elapsedText(result.startedAt, result.endedAt)}`} />)
      : <Badge status="default" text="当前没有运行中的进程" />;

  return (
    <Drawer
      open={task !== null}
      onClose={onClose}
      width={720}
      title={`运行输出 · ${task?.name ?? ''}`}
      extra={<Space>{status}<Button size="small" loading={loading} onClick={() => void pull(false)}>拉取新输出</Button></Space>}
    >
      {task ? (
        <Descriptions
          size="small"
          column={2}
          items={[
            { key: 'id', label: '任务 ID', children: <Typography.Text code>{task.id}</Typography.Text> },
            { key: 'pid', label: '进程', children: running ? `PID ${task.active?.pid}` : result ? `PID ${result.pid}（已退出）` : '—' },
            { key: 'start', label: '开始时间', children: startIso ? clockText(Date.parse(startIso)) : '—' },
            { key: 'dur', label: '已用时间', children: elapsedText(startIso ?? '') || '—' },
            { key: 'log', label: '日志文件', span: 2, children: <Typography.Text style={{ fontSize: 12 }} code>{task.logPath ?? '该任务没有日志文件'}</Typography.Text> },
          ]}
        />
      ) : null}

      {missing ? <Alert style={{ marginTop: 12 }} type="warning" showIcon message="还没有这个任务的日志文件，运行开始后会出现。" /> : null}

      <pre ref={boxRef} className="run-log">
        {text || (running ? '进程已在运行，暂时没有新输出（Playwright 常常在结束时才打印）。' : '没有可显示的运行输出。')}
      </pre>

      {running ? (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          每 1.5 秒自动取一次新输出；跑完会在这里给出成功/失败，并弹一次提示。
        </Typography.Paragraph>
      ) : null}
    </Drawer>
  );
}
