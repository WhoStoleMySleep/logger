/**
 * Measures what the README is allowed to claim.
 *
 * Two numbers, because a buffered writer has two speeds and quoting only the
 * first one is how a logging library ends up advertising the speed of its
 * queue. `accepted` is how fast the calling code gets its thread back —
 * `write()` copies into the stream's buffer and returns. `drained` is how fast
 * the entries actually reach the file, flush and close included, which is the
 * rate a process can sustain without its log buffer growing forever.
 *
 * Run with: npm run bench
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/index';

const ENTRIES = 200_000;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'wsms-logger-bench-'));
  const logFilePath = join(dir, 'bench.log');

  try {
    const logger = createLogger({
      logFilePath,
      rotateByDate: false,
      onError: (error) => {
        throw error;
      },
    });

    const started = process.hrtime.bigint();
    for (let i = 0; i < ENTRIES; i++) {
      logger.info('request completed', { i, method: 'GET', status: 200 });
    }
    const accepted = process.hrtime.bigint();

    await logger.flush();
    await logger.close();
    const drained = process.hrtime.bigint();

    const perSecond = (from: bigint, to: bigint): number =>
      Math.round(ENTRIES / (Number(to - from) / 1e9));

    const bytes = statSync(logFilePath).size;

    console.log(
      `node       ${process.version} on ${process.platform}/${process.arch}`
    );
    console.log(`cpu        ${cpus()[0]?.model ?? 'unknown'}`);
    console.log(
      `entries    ${ENTRIES.toLocaleString('en-US')} (${Math.round(bytes / ENTRIES)} B each)`
    );
    console.log(
      `accepted   ${perSecond(started, accepted).toLocaleString('en-US')} logs/sec`
    );
    console.log(
      `drained    ${perSecond(started, drained).toLocaleString('en-US')} logs/sec`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
