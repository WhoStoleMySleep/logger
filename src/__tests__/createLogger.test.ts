jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  mkdirSync: jest.fn(),
  openSync: jest.fn().mockReturnValue(42),
  createWriteStream: jest.fn(),
  statSync: jest.fn().mockReturnValue({ size: 0 }),
  readdirSync: jest.fn().mockReturnValue([]),
}));

import * as fs from 'node:fs';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger, Logger } from '../logger';

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV?: string;
      LOG_FILE_PATH?: string;
      LOG_MAX_FILE_SIZE?: string;
      LOG_MAX_FILES?: string;
      LOG_ROTATE_BY_DATE?: string;
      LOG_MAX_DAYS?: string;
    }
  }
}

describe('createLogger', () => {
  const testConfigPath = resolve(process.cwd(), 'logger.config.json');
  const testConfigContent = {
    logFilePath: './logs/test-from-config.log',
    maxFileSize: 5 * 1024 * 1024,
    maxFiles: 3,
    env: {
      development: {
        logFilePath: './logs/test-dev.log',
        maxFileSize: 1 * 1024 * 1024,
      },
      production: {
        logFilePath: './logs/test-prod.log',
        maxFiles: 10,
      },
    },
  };

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
    (fs.createWriteStream as jest.Mock).mockReturnValue(mockStream);
    (fs.statSync as jest.Mock).mockReturnValue({ size: 0 });

    if (existsSync(testConfigPath)) {
      unlinkSync(testConfigPath);
    }
  });

  afterEach(() => {
    if (existsSync(testConfigPath)) {
      unlinkSync(testConfigPath);
    }
  });

  describe('with direct options', () => {
    it('should create logger with provided options', () => {
      const logger = createLogger({
        logFilePath: './logs/direct.log',
        maxFileSize: 2 * 1024 * 1024,
        maxFiles: 7,
      });

      expect(logger).toBeInstanceOf(Logger);

      logger.info('Test message');

      expect(fs.createWriteStream).toHaveBeenCalledWith(
        resolve('./logs/direct-2026-03-04.log'),
        { fd: 42, autoClose: true }
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"level":"info"')
      );
    });

    it('should use defaults when options are partial', () => {
      const logger = createLogger({
        logFilePath: './logs/partial.log',
      });

      expect(logger).toBeInstanceOf(Logger);

      logger.info('Test message');

      expect(fs.createWriteStream).toHaveBeenCalledWith(
        resolve('./logs/partial-2026-03-04.log'),
        { fd: 42, autoClose: true }
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"level":"info"')
      );
    });

    it('should use plain path when rotateByDate is false', () => {
      const logger = createLogger({
        logFilePath: './logs/direct.log',
        rotateByDate: false,
      });

      logger.info('Test message');

      expect(fs.createWriteStream).toHaveBeenCalledWith(
        resolve('./logs/direct.log'),
        { fd: 42, autoClose: true }
      );
    });
  });

  describe('with config file', () => {
    beforeEach(() => {
      writeFileSync(testConfigPath, JSON.stringify(testConfigContent, null, 2));
    });

    it('should load configuration from JSON config file', () => {
      const logger = createLogger();

      expect(logger).toBeInstanceOf(Logger);

      logger.info('Test message');

      expect(fs.createWriteStream).toHaveBeenCalledWith(
        resolve('./logs/test-from-config-2026-03-04.log'),
        { fd: 42, autoClose: true }
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"level":"info"')
      );
    });

    it('should apply environment-specific config', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const logger = createLogger();

      expect(logger).toBeInstanceOf(Logger);

      logger.info('Test message');

      expect(fs.createWriteStream).toHaveBeenCalledWith(
        resolve('./logs/test-dev-2026-03-04.log'),
        { fd: 42, autoClose: true }
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"level":"info"')
      );

      if (originalEnv) {
        process.env.NODE_ENV = originalEnv;
      } else {
        delete process.env.NODE_ENV;
      }
    });

    it('should use custom config path', () => {
      const customConfigPath = resolve(process.cwd(), 'custom-logger.json');
      writeFileSync(
        customConfigPath,
        JSON.stringify({
          logFilePath: './logs/custom.log',
          maxFiles: 15,
        })
      );

      const logger = createLogger(undefined, customConfigPath);

      expect(logger).toBeInstanceOf(Logger);

      logger.info('Test message');

      expect(fs.createWriteStream).toHaveBeenCalledWith(
        resolve('./logs/custom-2026-03-04.log'),
        { fd: 42, autoClose: true }
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"level":"info"')
      );

      unlinkSync(customConfigPath);
    });
  });

  describe('with environment variables', () => {
    let originalEnv: Record<string, string | undefined>;

    beforeEach(() => {
      originalEnv = {
        LOG_FILE_PATH: process.env.LOG_FILE_PATH,
        LOG_MAX_FILE_SIZE: process.env.LOG_MAX_FILE_SIZE,
        LOG_MAX_FILES: process.env.LOG_MAX_FILES,
        LOG_ROTATE_BY_DATE: process.env.LOG_ROTATE_BY_DATE,
        LOG_MAX_DAYS: process.env.LOG_MAX_DAYS,
        NODE_ENV: process.env.NODE_ENV,
      };
    });

    afterEach(() => {
      Object.keys(originalEnv).forEach((key) => {
        if (originalEnv[key]) {
          process.env[key] = originalEnv[key];
        } else {
          delete process.env[key];
        }
      });
    });

    it('should use environment variables for configuration', () => {
      process.env.LOG_FILE_PATH = './logs/from-env.log';
      process.env.LOG_MAX_FILE_SIZE = '8388608';
      process.env.LOG_MAX_FILES = '12';

      const logger = createLogger();

      expect(logger).toBeInstanceOf(Logger);

      logger.info('Test message');

      expect(fs.createWriteStream).toHaveBeenCalledWith(
        resolve('./logs/from-env-2026-03-04.log'),
        { fd: 42, autoClose: true }
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"level":"info"')
      );
    });

    it('should prioritize direct options over environment variables', () => {
      process.env.LOG_FILE_PATH = './logs/from-env.log';
      process.env.LOG_MAX_FILE_SIZE = '8388608';

      const logger = createLogger({
        logFilePath: './logs/direct-override.log',
      });

      expect(logger).toBeInstanceOf(Logger);

      logger.info('Test message');

      expect(fs.createWriteStream).toHaveBeenCalledWith(
        resolve('./logs/direct-override-2026-03-04.log'),
        { fd: 42, autoClose: true }
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"level":"info"')
      );
    });

    it('should disable date rotation via LOG_ROTATE_BY_DATE=false', () => {
      process.env.LOG_FILE_PATH = './logs/no-date.log';
      process.env.LOG_ROTATE_BY_DATE = 'false';

      const logger = createLogger();
      logger.info('test');

      expect(fs.createWriteStream).toHaveBeenCalledWith(
        resolve('./logs/no-date.log'),
        { fd: 42, autoClose: true }
      );
    });
  });

  describe('priority order', () => {
    beforeEach(() => {
      process.env.LOG_FILE_PATH = './logs/env-priority.log';
      process.env.LOG_MAX_FILES = '20';

      writeFileSync(
        testConfigPath,
        JSON.stringify({
          logFilePath: './logs/config-priority.log',
          maxFileSize: 3 * 1024 * 1024,
          maxFiles: 5,
        })
      );
    });

    afterEach(() => {
      delete process.env.LOG_FILE_PATH;
      delete process.env.LOG_MAX_FILES;
    });

    it('should prioritize: direct options > env vars > config file > defaults', () => {
      const logger = createLogger({
        logFilePath: './logs/direct-priority.log',
      });

      logger.info('Test message');

      expect(fs.createWriteStream).toHaveBeenCalledWith(
        resolve('./logs/direct-priority-2026-03-04.log'),
        { fd: 42, autoClose: true }
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"level":"info"')
      );
    });

    it('should let environment variables override the config file', () => {
      const logger = createLogger();

      logger.info('Test message');

      expect(fs.createWriteStream).toHaveBeenCalledWith(
        resolve('./logs/env-priority-2026-03-04.log'),
        { fd: 42, autoClose: true }
      );
    });

    it('should keep lower layers for fields the options do not set', () => {
      process.env.LOG_ROTATE_BY_DATE = 'false';

      const logger = createLogger({ logFilePath: './logs/only-path.log' });
      logger.info('Test message');

      // The path comes from the options, rotateByDate from the environment:
      // a layer overrides field by field, it does not replace the ones below.
      expect(fs.createWriteStream).toHaveBeenCalledWith(
        resolve('./logs/only-path.log'),
        { fd: 42, autoClose: true }
      );

      delete process.env.LOG_ROTATE_BY_DATE;
    });

    it('should use config file when no direct options provided', () => {
      delete process.env.LOG_FILE_PATH;

      const logger = createLogger();

      logger.info('Test message');

      expect(fs.createWriteStream).toHaveBeenCalledWith(
        resolve('./logs/config-priority-2026-03-04.log'),
        { fd: 42, autoClose: true }
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"level":"info"')
      );
    });
  });

  describe('invalid configuration', () => {
    const badEnv = [
      ['LOG_MAX_FILE_SIZE', 'oops'],
      ['LOG_MAX_FILES', '0'],
      ['LOG_MAX_DAYS', '-3'],
    ] as const;

    afterEach(() => {
      for (const [name] of badEnv) {
        delete process.env[name];
      }
    });

    it.each(badEnv)('should reject %s=%s', (name, value) => {
      process.env[name] = value;

      // Silently ignoring it is worse than failing: a NaN limit turns every
      // size comparison false, and rotation quietly stops happening.
      expect(() => createLogger()).toThrow(new RegExp(name));
    });

    it('should reject a config file that is not valid JSON', () => {
      writeFileSync(testConfigPath, '{ "logFilePath": ');

      expect(() => createLogger()).toThrow(/not valid JSON/);
    });

    it('should fall back to the default path when options omit it', () => {
      const logger = createLogger({ maxFiles: 3 });
      logger.info('Test message');

      expect(fs.createWriteStream).toHaveBeenCalledWith(
        resolve('./logs/app-2026-03-04.log'),
        { fd: 42, autoClose: true }
      );
    });
  });

  describe('fallback behavior', () => {
    it('should use defaults when no configuration is available', () => {
      const logger = createLogger();

      expect(logger).toBeInstanceOf(Logger);

      logger.info('Test message');

      expect(fs.createWriteStream).toHaveBeenCalledWith(
        resolve('./logs/app-2026-03-04.log'),
        { fd: 42, autoClose: true }
      );
      expect(mockStream.write).toHaveBeenCalledWith(
        expect.stringContaining('"level":"info"')
      );
    });
  });
});
