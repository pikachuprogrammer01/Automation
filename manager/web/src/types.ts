export interface Schedule {
  hour: number;
  minute: number;
}

export interface ActiveRun {
  kind: string;
  pid: number;
  startedAt: string;
  /** 本次运行开始时日志文件的字节偏移，用于只取新增输出。 */
  logStart: number;
}

export interface RunResult extends ActiveRun {
  endedAt: string;
  code: number | null;
  ok: boolean;
}

export interface LogChunk {
  text: string;
  size: number;
  from: number;
  missing?: boolean;
}

export interface Task {
  id: string;
  name: string;
  site?: string;
  type?: string;
  url?: string;
  launchLabel?: string;
  command?: string[];
  schedule: Schedule | null;
  defaultSchedule?: Schedule | null;
  plistExists: boolean;
  profileExists: boolean;
  taskDirExists: boolean;
  logExists: boolean;
  loaded: boolean;
  profileDir?: string;
  taskDir?: string;
  logPath?: string;
  configPath?: string;
  accountKey?: string;
  credentialBackend: string;
  credentialService: string | null;
  credentialUsername: string | null;
  lastLog: string;
  active: ActiveRun | null;
  lastRun: RunResult | null;
}

export interface SystemInfo {
  manager: string;
  port: number;
}

/** ok=正常轮询；closed=用户主动关闭管理器；lost=连接中断；backend=进程在但接口异常 */
export type Phase = 'ok' | 'closed' | 'lost' | 'backend';

export type FailKind = 'unreachable' | 'backend' | 'request';

export class ApiError extends Error {
  kind: FailKind;

  constructor(kind: FailKind, message: string) {
    super(message);
    this.kind = kind;
  }
}
