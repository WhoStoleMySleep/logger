/**
 * Checks the tarball npm would publish, not the source Jest runs.
 *
 * The test suite imports TypeScript through ts-jest, so it never touches the
 * files consumers actually load: the bundled `dist/index.js` and
 * `dist/index.cjs`, reached through the `exports` map. A package can pass every
 * test and still be unloadable — a missing declaration file, an entry point
 * pointing at a path `files` excluded, a CJS build that crashes on `require`.
 * So this packs the real artefact, unpacks it somewhere else and uses it the
 * two ways a consumer can.
 *
 * Run with: node scripts/smoke.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let failed = false;

function fail(message) {
  console.error(`smoke: FAIL ${message}`);
  failed = true;
}

function ok(message) {
  console.log(`smoke: ok   ${message}`);
}

const workDir = mkdtempSync(join(tmpdir(), 'wsms-logger-smoke-'));

try {
  const packed = execFileSync(
    'npm',
    ['pack', '--json', '--pack-destination', workDir],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const tarball = join(workDir, JSON.parse(packed)[0].filename);
  execFileSync('tar', ['-xzf', tarball, '-C', workDir]);

  // npm always unpacks a tarball into a directory called `package`.
  const pkgDir = join(workDir, 'package');
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'));

  // Every path the manifest promises has to be inside the tarball: `files`
  // narrows what ships, and an entry point left outside it is only visible
  // once someone installs the published package.
  const entries = new Set([
    manifest.main,
    manifest.module,
    manifest.types,
    manifest.exports['.'].import,
    manifest.exports['.'].types,
    manifest.exports['.'].require.default,
    manifest.exports['.'].require.types,
  ]);

  for (const entry of entries) {
    if (existsSync(join(pkgDir, entry))) ok(`${entry} is in the tarball`);
    else fail(`${entry} is declared in package.json but not in the tarball`);
  }

  const EXPECTED = ['Logger', 'LogLevel', 'createLogger'];
  const missing = (mod) => EXPECTED.filter((name) => typeof mod[name] === 'undefined');

  const require = createRequire(import.meta.url);
  const cjs = require(join(pkgDir, manifest.main));
  const missingCjs = missing(cjs);
  if (missingCjs.length) fail(`require() is missing ${missingCjs.join(', ')}`);
  else ok('require() exports the whole API');

  const esm = await import(pathToFileURL(join(pkgDir, manifest.module)).href);
  const missingEsm = missing(esm);
  if (missingEsm.length) fail(`import() is missing ${missingEsm.join(', ')}`);
  else ok('import() exports the whole API');

  // The bundle is loadable; now check it still writes. A logger that imports
  // cleanly and produces no file is the failure this exists to catch.
  const logDir = join(workDir, 'logs');
  const logger = esm.createLogger({
    logFilePath: join(logDir, 'smoke.log'),
    rotateByDate: false,
    onError: (error) => fail(`the logger reported ${error.message}`),
  });

  logger.info('smoke', { from: 'smoke.mjs' });
  logger.child({ component: 'smoke' }).error('child entry');
  await logger.flush();
  await logger.close();

  const written = join(logDir, 'smoke.log');
  if (!existsSync(written)) {
    fail(`${written} was never created`);
  } else {
    const lines = readFileSync(written, 'utf-8').trim().split('\n');
    const entries = lines.map((line) => JSON.parse(line));

    if (entries.length !== 2) fail(`expected 2 entries, found ${entries.length}`);
    else if (entries[0].level !== 'info' || entries[0].message !== 'smoke')
      fail(`the first entry reads ${lines[0]}`);
    else if (entries[1].component !== 'smoke')
      fail('the child logger did not add its context');
    else ok('the built logger writes JSONL to disk');
  }
} catch (error) {
  fail(error.message);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failed) {
  console.error('smoke: the package would not work as published');
  process.exit(1);
}

console.log('smoke: the package loads and logs both ways');
