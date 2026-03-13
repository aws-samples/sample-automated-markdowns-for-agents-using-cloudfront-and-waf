type LogLevel = 'info' | 'error';

interface LogEntry {
  level: LogLevel;
  metric: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, metric: string, fields: Record<string, unknown> = {}): void {
  const entry: LogEntry = { level, metric, ...fields };
  const message = JSON.stringify(entry);
  if (level === 'error') {
    console.error(message);
  } else {
    console.log(message);
  }
}

export const logger = {
  info(metric: string, fields?: Record<string, unknown>): void {
    emit('info', metric, fields);
  },
  error(metric: string, fields?: Record<string, unknown>): void {
    emit('error', metric, fields);
  },
};
