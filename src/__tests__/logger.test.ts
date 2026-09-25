jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  openSync: jest.fn().mockReturnValue(42),
  createWriteStream: jest.fn(),
  statSync: jest.fn().mockReturnValue({ size: 0 }),
  renameSync: jest.fn(),
  unlinkSync: jest.fn(),
  readdirSync: jest.fn().mockReturnValue([]),
}));

import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { Logger, LogLevel } from '../logger';

describe('Logger', () => {
  const mockLogFilePath = '/tmp/test.log';
  const resolvedPath = resolve(mockLogFilePath);
  const resolvedDatePath = resolvedPath.replace('.log', '-2026-03-04.log');

  let mockStream: {
    write: jest.Mock;
    end: jest.Mock;
    writableNeedDrain: boolean;
    once: jest.Mock;
    on: jest.Mock;
  };

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-04T10:00:00Z'));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockStream = {
      write: jest.fn(),
      end: jest.fn((cb?: () => void) => cb?.()),
      writableNeedDrain: false,
      once: jest.fn(),
      on: jest.fn(),
    };
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.statSync as jest.Mock).mockReturnValue({ size: 0 });
    (fs.createWriteStream as jest.Mock).mockReturnValue(mockStream);
  });

  describe('constructor', () => {
    it('should create logger with default options', () => {
      const logger = new Logger({ logFilePath: mockLogFilePath });
      expect(logger).toBeInstanceOf(Logger);
    });

    it('should create logger with custom options', () => {
      const logger = new Logger({
        logFilePath: mockLogFilePath,
        maxFileSize: 1024,
        maxFiles: 2,
      });
      expect(logger).toBeInstanceOf(Logger);
    });

    it.each([
      ['an empty path', { logFilePath: '' }, /logFilePath/],
      ['a blank path', { logFilePath: '   ' }, /logFilePath/],
      [
        'NaN as maxFileSize',
        { logFilePath: mockLogFilePath, maxFileSize: Number.NaN },
        /maxFileSize/,
      ],
      [
        'a zero maxFiles',
        { logFilePath: mockLogFilePath, maxFiles: 0 },
        /maxFiles/,
      ],
      [
        'a negative maxDays',
        { logFilePath: mockLogFilePath, maxDays: -1 },
        /maxDays/,
      ],
    ])('should reject %s', (_name, options, message) => {
      expect(() => new Logger(options as never)).toThrow(message);
    });
  });

  describe('log methods', () => {
    let logger: Logger;

    beforeEach(() => {
      logger = new Logger({ logFilePath: mockLogFilePath });
    });

    it('should log debug messages', () => {
      logger.debug('Debug message');

      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"level":"debug"')
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('Debug message')
      );
    });

    it('should log info messages', () => {
      logger.info('Info message');

      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"level":"info"')
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('Info message')
      );
    });

    it('should log warning messages', () => {
      logger.warn('Warning message');

      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"level":"warn"')
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('Warning message')
      );
    });

    it('should log error messages', () => {
      logger.error('Error message');

      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"level":"error"')
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('Error message')
      );
    });

    it('should log messages with data', () => {
      logger.info('Message with data', { userId: 123, action: 'login' });

      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"data":')
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"userId":123')
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"action":"login"')
      );
    });

    it('should write one JSON line per log entry', () => {
      logger.info('test');

      const [content] = (mockStream.write as jest.Mock).mock.calls[0];
      expect(content).toMatch(/^\{.*\}\n$/);
    });

    it('should not include data field when data is undefined', () => {
      logger.info('no data');

      const [content] = (mockStream.write as jest.Mock).mock.calls[0];
      expect(content).not.toContain('"data"');
    });

    it('should open stream to the date-stamped log file path by default', () => {
      logger.info('test');

      expect(fs.openSync).toHaveBeenCalledWith(resolvedDatePath, 'a');
      expect(fs.createWriteStream).toHaveBeenCalledWith(resolvedDatePath, {
        fd: 42,
        autoClose: true,
      });
    });

    it('should open stream to the plain path when rotateByDate is false', () => {
      const logger2 = new Logger({
        logFilePath: mockLogFilePath,
        rotateByDate: false,
      });
      logger2.info('test');

      expect(fs.openSync).toHaveBeenCalledWith(resolvedPath, 'a');
      expect(fs.createWriteStream).toHaveBeenCalledWith(resolvedPath, {
        fd: 42,
        autoClose: true,
      });
    });

    it('should create log directory if it does not exist', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      logger.info('test');

      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), {
        recursive: true,
      });
    });

    it('should only open the stream once across multiple writes', () => {
      logger.info('first');
      logger.info('second');
      logger.info('third');

      expect(fs.createWriteStream).toHaveBeenCalledTimes(1);
    });
  });

  describe('log rotation (size-based)', () => {
    it('should rotate when cumulative size exceeds maxFileSize', () => {
      const maxFileSize = 1024;
      const logger = new Logger({
        logFilePath: mockLogFilePath,
        maxFileSize,
        maxFiles: 3,
        rotateByDate: false,
      });

      (fs.statSync as jest.Mock).mockReturnValue({ size: maxFileSize - 1 });

      logger.info('trigger rotation');

      expect(fs.renameSync).toHaveBeenCalledWith(
        resolvedPath,
        `${resolvedPath}.1`
      );
    });

    it('should not rotate when file is within size limit', () => {
      const logger = new Logger({
        logFilePath: mockLogFilePath,
        maxFileSize: 10 * 1024 * 1024,
        rotateByDate: false,
      });

      (fs.statSync as jest.Mock).mockReturnValue({ size: 100 });

      logger.info('no rotation');

      expect(fs.renameSync).not.toHaveBeenCalled();
    });

    it('should not rotate when maxFileSize is not set', () => {
      const logger = new Logger({
        logFilePath: mockLogFilePath,
        rotateByDate: false,
      });

      (fs.statSync as jest.Mock).mockReturnValue({ size: 999999999 });

      logger.info('no rotation');

      expect(fs.renameSync).not.toHaveBeenCalled();
    });

    it('should delete oldest file when maxFiles is exceeded', () => {
      const maxFiles = 3;
      const logger = new Logger({
        logFilePath: mockLogFilePath,
        maxFileSize: 1,
        maxFiles,
        rotateByDate: false,
      });

      (fs.statSync as jest.Mock).mockReturnValue({ size: 2 });

      logger.info('trigger rotation');

      expect(fs.unlinkSync).toHaveBeenCalledWith(`${resolvedPath}.${maxFiles}`);
    });

    it('should reopen the stream after rotation', () => {
      const logger = new Logger({
        logFilePath: mockLogFilePath,
        maxFileSize: 1,
        rotateByDate: false,
      });

      (fs.statSync as jest.Mock).mockReturnValue({ size: 2 });

      logger.info('first write triggers rotation');
      logger.info('second write uses new stream');

      expect(fs.createWriteStream).toHaveBeenCalledTimes(2);
    });
  });

  describe('date rotation', () => {
    it('should write to date-stamped file by default', () => {
      const logger = new Logger({ logFilePath: mockLogFilePath });
      logger.info('test');

      expect(fs.openSync).toHaveBeenCalledWith(resolvedDatePath, 'a');
    });

    it('should rotate to new date file when day changes', () => {
      const logger = new Logger({ logFilePath: mockLogFilePath });
      logger.info('day 1');

      jest.setSystemTime(new Date('2026-03-05T10:00:00Z'));
      logger.info('day 2');
      jest.setSystemTime(new Date('2026-03-04T10:00:00Z'));

      const nextDatePath = resolvedPath.replace('.log', '-2026-03-05.log');
      expect(fs.openSync).toHaveBeenNthCalledWith(1, resolvedDatePath, 'a');
      expect(fs.openSync).toHaveBeenNthCalledWith(2, nextDatePath, 'a');
      expect(fs.createWriteStream).toHaveBeenCalledTimes(2);
    });

    it('should rotate size within a date file when maxFileSize is set', () => {
      const logger = new Logger({
        logFilePath: mockLogFilePath,
        maxFileSize: 1,
      });

      (fs.statSync as jest.Mock).mockReturnValue({ size: 2 });

      logger.info('trigger size rotation');

      expect(fs.renameSync).toHaveBeenCalledWith(
        resolvedDatePath,
        `${resolvedDatePath}.1`
      );
    });

    it('should delete old files when maxDays is set', () => {
      (fs.readdirSync as jest.Mock).mockReturnValue([
        'test-2026-02-28.log',
        'test-2026-03-03.log',
        'test-2026-03-04.log',
        'unrelated.log',
      ]);

      const logger = new Logger({
        logFilePath: mockLogFilePath,
        maxDays: 2,
      });

      jest.setSystemTime(new Date('2026-03-05T10:00:00Z'));
      logger.info('day 2');
      jest.setSystemTime(new Date('2026-03-04T10:00:00Z'));

      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('test-2026-02-28.log')
      );
      expect(fs.unlinkSync).not.toHaveBeenCalledWith(
        expect.stringContaining('test-2026-03-03.log')
      );
    });

    it('should not delete files when maxDays is not set', () => {
      (fs.readdirSync as jest.Mock).mockReturnValue(['test-2026-01-01.log']);

      const logger = new Logger({ logFilePath: mockLogFilePath });

      jest.setSystemTime(new Date('2026-03-05T10:00:00Z'));
      logger.info('day 2');
      jest.setSystemTime(new Date('2026-03-04T10:00:00Z'));

      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('child loggers', () => {
    let logger: Logger;

    beforeEach(() => {
      logger = new Logger({ logFilePath: mockLogFilePath });
    });

    it('should include child context in log entries', () => {
      const child = logger.child({ component: 'auth' });
      child.info('login');

      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"component":"auth"')
      );
    });

    it('should share the parent stream (createWriteStream called once)', () => {
      const child = logger.child({ component: 'auth' });
      logger.info('parent write');
      child.info('child write');

      expect(fs.createWriteStream).toHaveBeenCalledTimes(1);
    });

    it('should merge nested child contexts', () => {
      const child1 = logger.child({ component: 'auth' });
      const child2 = child1.child({ requestId: 'req-123' });

      child2.info('nested child log');

      const [content] = (mockStream.write as jest.Mock).mock.calls[0];
      expect(content).toContain('"component":"auth"');
      expect(content).toContain('"requestId":"req-123"');
    });

    it('child context should not bleed into parent logs', () => {
      const child = logger.child({ component: 'auth' });
      child.info('child message');
      logger.info('parent message');

      const calls = (mockStream.write as jest.Mock).mock.calls;
      const parentCall = calls[1][0] as string;
      expect(parentCall).not.toContain('"component"');
    });
  });

  describe('write failures', () => {
    /** Hands back the 'error' listener the logger attached to its stream. */
    const streamErrorHandler = (): ((error: Error) => void) =>
      (mockStream.on as jest.Mock).mock.calls.find(
        ([event]) => event === 'error'
      )?.[1] as (error: Error) => void;

    it('should route a stream error to onError instead of throwing', () => {
      const onError = jest.fn();
      const logger = new Logger({ logFilePath: mockLogFilePath, onError });

      logger.info('opens the stream');
      const fail = streamErrorHandler();
      expect(fail).toBeDefined();

      expect(() => fail(new Error('ENOSPC: no space left'))).not.toThrow();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'ENOSPC: no space left' })
      );
    });

    it('should reopen the file on the next write after a stream error', () => {
      const logger = new Logger({
        logFilePath: mockLogFilePath,
        onError: jest.fn(),
      });

      logger.info('first');
      expect(fs.createWriteStream).toHaveBeenCalledTimes(1);

      streamErrorHandler()(new Error('EBADF'));
      logger.info('second');

      expect(fs.createWriteStream).toHaveBeenCalledTimes(2);
    });

    it('should report a failure to open the file instead of throwing', () => {
      const onError = jest.fn();
      (fs.openSync as jest.Mock).mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied');
      });

      const logger = new Logger({ logFilePath: mockLogFilePath, onError });

      expect(() => logger.info('never reaches the disk')).not.toThrow();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'EACCES: permission denied' })
      );
      expect(mockStream.write).not.toHaveBeenCalled();
    });

    it('should survive an onError handler that throws', () => {
      const logger = new Logger({
        logFilePath: mockLogFilePath,
        onError: () => {
          throw new Error('the handler itself is broken');
        },
      });

      logger.info('opens the stream');
      expect(() => streamErrorHandler()(new Error('ENOSPC'))).not.toThrow();
    });

    it('should report each distinct failure to stderr once', () => {
      const stderr = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        const logger = new Logger({ logFilePath: mockLogFilePath });
        logger.info('opens the stream');
        const fail = streamErrorHandler();

        fail(new Error('ENOSPC'));
        fail(new Error('ENOSPC'));
        fail(new Error('EBADF'));

        const messages = stderr.mock.calls.map(([line]) => String(line));
        expect(messages.filter((m) => m.includes('ENOSPC'))).toHaveLength(1);
        expect(messages.filter((m) => m.includes('EBADF'))).toHaveLength(1);
      } finally {
        stderr.mockRestore();
      }
    });

    it('should pass onError down to child loggers', () => {
      const onError = jest.fn();
      const logger = new Logger({ logFilePath: mockLogFilePath, onError });
      const child = logger.child({ component: 'db' });

      child.info('opens the stream');
      streamErrorHandler()(new Error('ENOSPC'));

      expect(onError).toHaveBeenCalledTimes(1);
    });
  });

  describe('flush and close', () => {
    let logger: Logger;

    beforeEach(() => {
      logger = new Logger({ logFilePath: mockLogFilePath });
    });

    it('should resolve flush when stream is not draining', async () => {
      logger.info('test');
      await expect(logger.flush()).resolves.toBeUndefined();
    });

    it('should wait for drain event when stream needs draining', async () => {
      logger.info('test');
      mockStream.writableNeedDrain = true;

      let drained = false;
      const flushPromise = logger.flush().then(() => {
        drained = true;
      });

      expect(drained).toBe(false);

      const drainCallback = (mockStream.once as jest.Mock).mock.calls.find(
        ([event]) => event === 'drain'
      )?.[1] as (() => void) | undefined;
      drainCallback?.();

      await flushPromise;
      expect(drained).toBe(true);
    });

    it('should close the stream', async () => {
      logger.info('test');
      await logger.close();

      expect(mockStream.end).toHaveBeenCalled();
    });

    it('should resolve close when no stream is open', async () => {
      await expect(logger.close()).resolves.toBeUndefined();
    });

    it('should use log level enum values', () => {
      const logger2 = new Logger({ logFilePath: mockLogFilePath });
      logger2.log(LogLevel.INFO, 'enum test');

      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"level":"info"')
      );
    });
  });
});
