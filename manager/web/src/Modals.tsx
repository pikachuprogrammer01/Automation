import { Alert, Checkbox, Form, Input, InputNumber, Modal, Select, Tag, Typography } from 'antd';
import { useEffect } from 'react';
import { scheduleText } from './status';
import type { Task } from './types';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;

export interface NewTaskValues {
  name: string;
  id: string;
  url: string;
  blank: boolean;
}

/** 所有弹窗：确定按钮走 form.submit()，校验失败就地标红；取消和 × 不触发任何校验。 */
export function NewTaskModal({ open, initialId, loading, onCancel, onSubmit }: {
  open: boolean;
  initialId: string;
  loading: boolean;
  onCancel: () => void;
  onSubmit: (v: NewTaskValues) => Promise<void>;
}) {
  const [form] = Form.useForm<{ name: string; id: string; url: string; mode: 'record' | 'blank' }>();

  useEffect(() => {
    if (open) form.setFieldsValue({ name: '', id: initialId, url: '', mode: 'record' });
  }, [open, initialId, form]);

  return (
    <Modal
      title="新建自动化"
      open={open}
      okText="创建"
      cancelText="取消"
      confirmLoading={loading}
      onCancel={onCancel}
      onOk={() => form.submit()}
      destroyOnClose
    >
      <Typography.Paragraph type="secondary">
        创建后可以先「准备登录」再「开始录制」，避免把密码写进脚本。
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        requiredMark="optional"
        onFinish={(v) => void onSubmit({ name: v.name.trim(), id: v.id.trim(), url: v.url.trim(), blank: v.mode === 'blank' })}
      >
        <Form.Item name="name" label="名称" rules={[
          { required: true, message: '请填写名称' },
          { max: 80, message: '名称不超过 80 个字符' },
        ]}>
          <Input placeholder="例如：论坛每日签到" autoFocus />
        </Form.Item>
        <Form.Item name="id" label="任务 ID" extra="小写字母、数字和连字符，2-41 位" rules={[
          { required: true, message: '请填写任务 ID' },
          { pattern: ID_PATTERN, message: '格式不对：需以小写字母或数字开头，只能用小写字母、数字和连字符' },
        ]}>
          <Input placeholder="forum-daily" />
        </Form.Item>
        <Form.Item name="url" label="网址" rules={[
          { required: true, message: '请填写网址' },
          { pattern: /^https?:\/\/\S+$/, message: '需要以 http:// 或 https:// 开头' },
        ]}>
          <Input placeholder="https://example.com" />
        </Form.Item>
        <Form.Item name="mode" label="创建方式">
          <Select options={[
            { value: 'record', label: '录制操作' },
            { value: 'blank', label: '新建空白脚本' },
          ]} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function ScheduleModal({ task, open, loading, onCancel, onSubmit }: {
  task: Task | null;
  open: boolean;
  loading: boolean;
  onCancel: () => void;
  onSubmit: (hour: number, minute: number) => Promise<void>;
}) {
  const [form] = Form.useForm<{ hour: number; minute: number }>();

  useEffect(() => {
    if (open && task) form.setFieldsValue({ hour: task.schedule?.hour ?? 9, minute: task.schedule?.minute ?? 0 });
  }, [open, task, form]);

  return (
    <Modal
      title="修改执行时间"
      open={open}
      okText="保存并启用"
      cancelText="取消"
      confirmLoading={loading}
      onCancel={onCancel}
      onOk={() => form.submit()}
      destroyOnClose
    >
      {task ? (
        <Typography.Paragraph type="secondary">
          {task.name}（{task.id}）当前：每天 {scheduleText(task.schedule)}
        </Typography.Paragraph>
      ) : null}
      <Form form={form} layout="inline" onFinish={(v) => void onSubmit(v.hour, v.minute)}>
        <Form.Item name="hour" label="小时" rules={[{ required: true, type: 'integer', min: 0, max: 23, message: '请填写 0-23 的整数' }]}>
          <InputNumber min={0} max={23} precision={0} style={{ width: 110 }} />
        </Form.Item>
        <Form.Item name="minute" label="分钟" rules={[{ required: true, type: 'integer', min: 0, max: 59, message: '请填写 0-59 的整数' }]}>
          <InputNumber min={0} max={59} precision={0} style={{ width: 110 }} />
        </Form.Item>
      </Form>
      <Alert style={{ marginTop: 16 }} type="info" showIcon message="保存会立即写入 launchd 并启用该任务；只想暂时停掉请用「暂停」。" />
    </Modal>
  );
}

export interface PurgeValues {
  deleteCredential: boolean;
  deleteProfile: boolean;
  deleteLogs: boolean;
}

export function PurgeModal({ task, open, loading, onCancel, onSubmit }: {
  task: Task | null;
  open: boolean;
  loading: boolean;
  onCancel: () => void;
  onSubmit: (v: PurgeValues, confirm: string) => Promise<void>;
}) {
  const [form] = Form.useForm<PurgeValues & { confirm: string }>();
  const confirmId = Form.useWatch('confirm', form);
  const delCredential = Form.useWatch('deleteCredential', form);
  const delProfile = Form.useWatch('deleteProfile', form);
  const delLogs = Form.useWatch('deleteLogs', form);

  useEffect(() => {
    if (open) form.setFieldsValue({ deleteCredential: false, deleteProfile: false, deleteLogs: false, confirm: '' });
  }, [open, form]);

  if (!task) return null;

  const mark = (willDelete: boolean) => (willDelete ? <Tag color="error">删除</Tag> : <Tag>保留</Tag>);

  return (
    <Modal
      title={`彻底删除：${task.name}`}
      open={open}
      okText="确认彻底删除"
      okButtonProps={{ danger: true, disabled: confirmId !== task.id }}
      cancelText="取消"
      confirmLoading={loading}
      onCancel={onCancel}
      onOk={() => form.submit()}
      destroyOnClose
    >
      <Alert
        type="error"
        showIcon
        message="这个操作不可回滚"
        description={`定时任务与管理器登记一定会被删除；下面的数据只有勾选才会删除。任务 ID：${task.id}`}
      />

      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 16 }}
        onFinish={(v) => void onSubmit(
          { deleteCredential: v.deleteCredential, deleteProfile: v.deleteProfile, deleteLogs: v.deleteLogs },
          v.confirm.trim(),
        )}
      >
        <Form.Item name="deleteCredential" valuePropName="checked">
          <Checkbox>
            删除保存的账号凭据（macOS Keychain）
            {task.credentialUsername ? <Typography.Text type="secondary"> · 账号 {task.credentialUsername}</Typography.Text> : null}
          </Checkbox>
        </Form.Item>
        <Form.Item name="deleteProfile" valuePropName="checked">
          <Checkbox>
            删除专属浏览器 Profile / 登录状态
            {task.profileDir
              ? <Typography.Text type="secondary"> · {task.profileDir}{task.profileExists ? '' : '（当前不存在）'}</Typography.Text>
              : <Typography.Text type="secondary"> · 该任务没有 Profile</Typography.Text>}
          </Checkbox>
        </Form.Item>
        <Form.Item name="deleteLogs" valuePropName="checked">
          <Checkbox>
            删除该任务日志
            {task.logPath ? <Typography.Text type="secondary"> · {task.logPath}</Typography.Text> : null}
          </Checkbox>
        </Form.Item>
        <Form.Item name="confirm" label={`输入任务 ID「${task.id}」以确认`} rules={[
          { required: true, message: '请输入任务 ID' },
          {
            validator: (_, value) => (String(value ?? '').trim() === task.id
              ? Promise.resolve()
              : Promise.reject(new Error('与任务 ID 不一致'))),
          },
        ]}>
          <Input placeholder={task.id} autoComplete="off" />
        </Form.Item>
      </Form>

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
        执行结果预览：定时任务 <Tag color="error">删除</Tag>
        管理器登记 <Tag color="error">删除</Tag>
        {task.type === 'recorded' ? <>脚本目录 <Tag color="error">删除</Tag></> : <>脚本文件 {mark(false)}</>}
        {' '}凭据 {mark(Boolean(delCredential))}
        {' '}Profile {mark(Boolean(delProfile))}
        {' '}日志 {mark(Boolean(delLogs))}
      </Typography.Paragraph>
    </Modal>
  );
}
