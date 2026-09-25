import {
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

/**
 * Logger utility for creating structured log files
 */

export interface LoggerOptions {
  logFilePath: string;
  /**
   * Maximum file size in bytes before rotating.
   * When rotateByDate is true, rotation happens within the daily file.
   * @default undefined (no limit)
   */
  maxFileSize?: number;
  maxFiles?: number;
  /**
   * Rotate log file daily, naming files app-YYYY-MM-DD.log.
   * @default true
   */
  rotateByDate?: boolean;
  /**
   * Maximum number of daily log files to keep.
   * Older files are deleted on each daily rotation.
   * @default undefined (no limit)
   */
  maxDays?: number;
  /**
   * Called when a log entry cannot be written — the directory disappeared,
   * the disk filled up, the descriptor was closed underneath the stream.
   *
   * Write failures never throw: an application must not die because the
   * logger it uses could not reach the disk. Without a handler the message
   * goes to stderr once per distinct failure, so a failing write in a loop
   * does not become its own flood.
   * @default undefined (report to stderr)
   */
  onError?: (error: Error) => void;
}

export interface LoggerConfig extends LoggerOptions {
  /**
   * Environment-specific configurations
   */
  env?: {
    development?: Partial<LoggerOptions>;
    production?: Partial<LoggerOptions>;
    test?: Partial<LoggerOptions>;
  };
}

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: unknown;
}

/**
 * Rejects a misconfigured limit at construction time.
 *
 * Unlike a write failure, a bad option is a programming or deployment
 * mistake, and it is silent in the worst way: `maxFileSize: NaN` makes every
 * size comparison false, so rotation simply never happens and the file grows
 * until the disk is full.
 */
function assertPositive(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(
      `@wsms/logger: ${field} must be a positive number, received ${String(value)}`
    );
  }
}

export class Logger {
  private readonly filePath: string;
  private readonly dir: string;
  private readonly maxFileSize: number | undefined;
  private readonly maxFiles: number;
  private readonly rotateByDate: boolean;
  private readonly maxDays: number | undefined;
  private readonly onError: ((error: Error) => void) | undefined;
  private activeFilePath: string;
  private currentDate: string;
  private stream: WriteStream | null = null;
  private currentSize = 0;
  private initialized = false;
  private readonly context: Record<string, unknown>;
  private root: Logger;
  private readonly reported = new Set<string>();

  /**
   * Last formatted timestamp, shared by every logger in the process.
   *
   * `toISOString()` costs roughly 460 ns and is the single most expensive part
   * of writing an entry — more than serialising it. Entries emitted within the
   * same millisecond carry the same timestamp anyway, so the string is reused
   * until the clock ticks. Keyed on the millisecond it was built from, which
   * makes the result identical to calling `new Date().toISOString()` directly.
   */
  private static cachedMs = 0;
  private static cachedIso = '';

  public constructor(
    options: LoggerOptions,
    context: Record<string, unknown> = {}
  ) {
    if (
      typeof options.logFilePath !== 'string' ||
      !options.logFilePath.trim()
    ) {
      throw new Error('@wsms/logger: logFilePath must be a non-empty string');
    }
    assertPositive(options.maxFileSize, 'maxFileSize');
    assertPositive(options.maxFiles, 'maxFiles');
    assertPositive(options.maxDays, 'maxDays');

    this.maxFileSize = options.maxFileSize;
    this.maxFiles = options.maxFiles ?? 5;
    this.rotateByDate = options.rotateByDate ?? true;
    this.maxDays = options.maxDays;
    this.onError = options.onError;
    this.filePath = resolve(options.logFilePath);
    this.dir = dirname(this.filePath);
    this.context = context;
    this.root = this;
    this.currentDate = new Date().toISOString().slice(0, 10);
    this.activeFilePath = this.rotateByDate
      ? this.getDateFilePath(this.currentDate)
      : this.filePath;
  }

  private getDateFilePath(date: string): string {
    const ext = extname(this.filePath);
    if (!ext) return `${this.filePath}-${date}`;
    return `${this.filePath.slice(0, -ext.length)}-${date}${ext}`;
  }

  /**
   * Hands a failure to the configured handler, or to stderr once.
   *
   * A handler that throws is swallowed: the whole point of routing errors
   * here is that logging cannot take the process down with it.
   */
  private report(error: Error): void {
    const root = this.root;
    const handler = root.onError;

    if (handler) {
      try {
        handler(error);
      } catch {}
      return;
    }

    if (root.reported.has(error.message)) return;
    root.reported.add(error.message);
    process.stderr.write(`@wsms/logger: ${error.message}\n`);
  }

  private init(): boolean {
    if (this.initialized) return true;

    try {
      if (!existsSync(this.dir)) {
        mkdirSync(this.dir, { recursive: true });
      }

      this.currentSize = existsSync(this.activeFilePath)
        ? statSync(this.activeFilePath).size
        : 0;

      // Open the file synchronously so it exists on disk before any rotation
      // attempt. createWriteStream's own open() is async and would create a race
      // condition in tight synchronous loops where rotate() is called before the
      // file is physically created.
      const fd = openSync(this.activeFilePath, 'a');
      const stream = createWriteStream(this.activeFilePath, {
        fd,
        autoClose: true,
      });

      // An unhandled 'error' on a stream is a process-level crash. Dropping the
      // stream here also means the next write reopens the file, which is what
      // recovers the logger once the directory or the disk comes back.
      stream.on('error', (error: Error) => {
        this.stream = null;
        this.initialized = false;
        this.report(error);
      });

      this.stream = stream;
      this.initialized = true;
      return true;
    } catch (error) {
      this.stream = null;
      this.initialized = false;
      this.report(error as Error);
      return false;
    }
  }

  private rotateDateFile(newDate: string): void {
    this.stream?.end();
    this.stream = null;
    this.initialized = false;
    this.currentDate = newDate;
    this.activeFilePath = this.getDateFilePath(newDate);
    this.currentSize = 0;
    this.cleanupOldDays();
  }

  private cleanupOldDays(): void {
    if (!this.maxDays) return;

    const ext = extname(this.filePath);
    const base = basename(this.filePath, ext);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.maxDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    try {
      const toDelete = readdirSync(this.dir).filter((f) => {
        if (!f.startsWith(`${base}-`)) return false;
        if (ext && !f.endsWith(ext)) return false;
        const dateStr = ext
          ? f.slice(base.length + 1, -ext.length)
          : f.slice(base.length + 1);
        return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr < cutoffStr;
      });

      for (const file of toDelete) {
        unlinkSync(join(this.dir, file));
      }
    } catch (error) {
      this.report(error as Error);
    }
  }

  private writeEntry(line: string, today?: string): void {
    if (this.rotateByDate) {
      const nextDate = today ?? new Date().toISOString().slice(0, 10);
      if (nextDate !== this.currentDate) {
        this.rotateDateFile(nextDate);
      }
    }

    if (!this.init()) return;
    const stream = this.stream;
    if (!stream) return;

    try {
      stream.write(line);
    } catch (error) {
      this.report(error as Error);
      return;
    }

    // Only size-based rotation reads currentSize, and measuring a line costs
    // about 5% of the write path.
    if (this.maxFileSize === undefined) return;

    this.currentSize += Buffer.byteLength(line, 'utf-8');

    if (this.currentSize >= this.maxFileSize) {
      this.rotate();
    }
  }

  public log(level: LogLevel, message: string, data?: unknown): void {
    const ms = Date.now();
    if (ms !== Logger.cachedMs) {
      Logger.cachedMs = ms;
      Logger.cachedIso = new Date(ms).toISOString();
    }
    const timestamp = Logger.cachedIso;
    const entry: Record<string, unknown> = {
      timestamp,
      level,
      message,
      ...this.context,
    };
    if (data !== undefined) {
      entry['data'] = data;
    }
    const line = JSON.stringify(entry) + '\n';
    this.root.writeEntry(line, timestamp.slice(0, 10));
  }

  private rotate(): void {
    this.stream?.end();
    this.stream = null;
    this.initialized = false;

    const base = this.activeFilePath;

    try {
      const oldestPath = `${base}.${this.maxFiles}`;
      if (existsSync(oldestPath)) {
        unlinkSync(oldestPath);
      }

      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const src = `${base}.${i}`;
        const dest = `${base}.${i + 1}`;
        if (existsSync(src)) {
          renameSync(src, dest);
        }
      }

      renameSync(base, `${base}.1`);
    } catch (error) {
      this.report(error as Error);
    }

    this.currentSize = 0;
  }

  /**
   * Create a child logger that inherits this logger's config and shares
   * its write stream, with additional default context fields.
   */
  public child(context: Record<string, unknown>): Logger {
    const childOptions: LoggerOptions = {
      logFilePath: this.filePath,
      maxFiles: this.maxFiles,
      rotateByDate: this.rotateByDate,
    };
    if (this.maxFileSize !== undefined) {
      childOptions.maxFileSize = this.maxFileSize;
    }
    if (this.maxDays !== undefined) {
      childOptions.maxDays = this.maxDays;
    }
    if (this.onError !== undefined) {
      childOptions.onError = this.onError;
    }
    const child = new Logger(childOptions, { ...this.context, ...context });
    child.root = this.root;
    return child;
  }

  /**
   * Returns a promise that resolves once the stream's write buffer drains.
   */
  public flush(): Promise<void> {
    const root = this.root;
    return new Promise<void>((res) => {
      if (!root.stream || !root.stream.writableNeedDrain) return res();
      root.stream.once('drain', res);
    });
  }

  /**
   * Gracefully closes the underlying write stream.
   */
  public close(): Promise<void> {
    const root = this.root;
    return new Promise<void>((res) => {
      if (!root.stream) return res();
      root.stream.end(res);
      root.stream = null;
      root.initialized = false;
    });
  }

  public debug(message: string, data?: unknown): void {
    this.log(LogLevel.DEBUG, message, data);
  }

  public info(message: string, data?: unknown): void {
    this.log(LogLevel.INFO, message, data);
  }

  public warn(message: string, data?: unknown): void {
    this.log(LogLevel.WARN, message, data);
  }

  public error(message: string, data?: unknown): void {
    this.log(LogLevel.ERROR, message, data);
  }
}

/** Config file names looked up in the working directory, in this order. */
const CONFIG_FILE_NAMES = ['logger.config.json', '.loggerrc', '.loggerrc.json'];

/** Options applied when nothing else supplies them. */
const DEFAULT_OPTIONS: Partial<LoggerOptions> = {
  logFilePath: './logs/app.log',
  maxFiles: 5,
};

/**
 * Load configuration from a JSON config file.
 *
 * A file that exists but does not parse throws rather than falling back to
 * defaults: a typo in the config would otherwise send the whole application's
 * logs to a path nobody is watching, with nothing said about it.
 */
function loadConfigFile(configPath?: string): LoggerConfig | null {
  const candidates = configPath ? [configPath] : CONFIG_FILE_NAMES;

  for (const path of candidates) {
    const fullPath = resolve(process.cwd(), path);
    if (!existsSync(fullPath)) continue;

    let content: string;
    try {
      content = readFileSync(fullPath, 'utf-8');
    } catch (error) {
      throw new Error(
        `@wsms/logger: cannot read config file ${fullPath}: ${(error as Error).message}`
      );
    }

    try {
      return JSON.parse(content) as LoggerConfig;
    } catch (error) {
      throw new Error(
        `@wsms/logger: config file ${fullPath} is not valid JSON: ${(error as Error).message}`
      );
    }
  }

  return null;
}

/**
 * A numeric environment variable is either a usable number or a mistake worth
 * reporting — `parseInt` turning "10mb" into 10 or "oops" into NaN silently is
 * how a rotation limit stops existing.
 */
function numericEnv(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(
      `@wsms/logger: ${name} must be a positive number, received "${raw}"`
    );
  }
  return value;
}

/**
 * Get configuration from environment variables
 */
function getEnvConfig(): Partial<LoggerOptions> {
  const config: Partial<LoggerOptions> = {};

  const filePath = process.env['LOG_FILE_PATH'];
  if (filePath) {
    config.logFilePath = filePath;
  }

  const maxFileSize = process.env['LOG_MAX_FILE_SIZE'];
  if (maxFileSize) {
    config.maxFileSize = numericEnv('LOG_MAX_FILE_SIZE', maxFileSize);
  }

  const maxFiles = process.env['LOG_MAX_FILES'];
  if (maxFiles) {
    config.maxFiles = numericEnv('LOG_MAX_FILES', maxFiles);
  }

  if (process.env['LOG_ROTATE_BY_DATE'] !== undefined) {
    config.rotateByDate = process.env['LOG_ROTATE_BY_DATE'] !== 'false';
  }

  const maxDays = process.env['LOG_MAX_DAYS'];
  if (maxDays) {
    config.maxDays = numericEnv('LOG_MAX_DAYS', maxDays);
  }

  return config;
}

/** Copies only the keys a source actually defines, so no layer erases the one below it. */
function assignDefined(
  target: Partial<LoggerOptions>,
  source: Partial<LoggerOptions> | undefined
): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      (target as Record<string, unknown>)[key] = value;
    }
  }
}

/**
 * Create a logger from defaults, a config file, the environment and explicit
 * options — merged field by field, each layer overriding only what it sets.
 *
 * Environment variables sit above the config file because they are how a
 * deployment adjusts a checked-in file it cannot edit.
 */
export function createLogger(
  options?: Partial<LoggerOptions>,
  configPath?: string
): Logger {
  const fileConfig = loadConfigFile(configPath);
  const nodeEnv = process.env['NODE_ENV'] || 'development';

  const merged: Partial<LoggerOptions> = { ...DEFAULT_OPTIONS };

  if (fileConfig) {
    const { env, ...base } = fileConfig;
    assignDefined(merged, base);
    assignDefined(merged, env?.[nodeEnv as keyof typeof env]);
  }

  assignDefined(merged, getEnvConfig());
  assignDefined(merged, options);

  return new Logger(merged as LoggerOptions);
}
