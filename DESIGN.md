# Design notes

Why the library is shaped the way it is. The README says what it does; this
says what was decided against, and what is still missing.

## Shape

```
src/
  index.ts     the public surface — Logger, LogLevel, createLogger
  logger.ts    everything else: rotation, context, config resolution
scripts/
  smoke.mjs    packs the tarball and loads it as a consumer would
bench/
  throughput.ts  the number the README is allowed to quote
```

One file holds the implementation because there is one moving part: a write
stream with a filename policy around it. Splitting rotation, configuration and
context into modules would add three import graphs to about four hundred lines.

## 1. JSONL, not formatted text

Every entry is one `JSON.stringify` and a newline. A line can be read by `jq`,
shipped to Loki or Elasticsearch without a parser, and tailed by a human at a
pinch. The alternative — a pretty console format — needs colour handling, a
column layout and a second parser on the collecting end, none of which a file
logger needs to own. Formatting is a consumer's concern; the file stays
machine-readable.

This is also why there is no `pretty` option. It would double the output paths
and halve the guarantee that every line parses.

## 2. The file is opened synchronously, then written asynchronously

`createWriteStream` opens its descriptor asynchronously. In a tight synchronous
loop — the shape of every benchmark and a fair few real handlers — the size
limit can be reached and `rotate()` called before the file physically exists,
and the rename fails on a file that is not there yet.

So the descriptor comes from `openSync` and is handed to the stream (`fd`), and
the writes stay buffered and asynchronous. The open costs one syscall at
startup; the writes keep the calling thread free, which is where the throughput
in the README comes from.

The price is stated rather than hidden: entries sitting in the buffer are lost
if the process is killed outright. `flush()` and `close()` exist for the
shutdown path, and the README shows them on `SIGTERM`.

## 3. Children share the parent's stream

`logger.child({ component: 'http' })` returns a new `Logger` that merges context
into every entry, but its `root` points at the logger it came from, and all
writes go through `root.writeEntry`.

The obvious implementation — a child with its own stream on the same path —
gives two descriptors writing to one file with independent buffers, so lines
interleave mid-entry and the size counters each see half the traffic. Sharing
one stream means one buffer, one byte count and one rotation.

Context merges on the way down, so a child of a child carries both sets of
fields, and a parent never sees a child's.

## 4. Two rotations, stacked in one direction

Daily rotation decides the filename (`app-2026-09-25.log`); size rotation shifts
numbered copies inside whatever file the day produced (`app-2026-09-25.log.1`).
They compose in that order and not the other way round, because the date is
what an operator greps for and the size suffix is bookkeeping.

`maxDays` deletes by the date in the filename, not by mtime — a restored backup
or a `touch` should not make yesterday's log look current.

## 5. A bad option throws, a failed write does not

Two failure modes that look similar and are not.

A misconfigured option — `maxFileSize: NaN` from an unparsed environment
variable, an empty path, a config file with a trailing comma — is a mistake
made before the program ran, and it is silent in the worst way: `NaN` makes
every size comparison false, so rotation never happens and the disk fills up
months later. These throw from `createLogger` and from the `Logger` constructor,
at startup, where a stack trace still points at the cause.

A write that fails — the disk filled, the directory was moved out from under a
running process, the descriptor was closed — is a runtime condition, and the
library must not turn it into a crash. **An application does not die because
the logger it uses could not reach the disk.** Failures go to the `onError`
handler, or to stderr once per distinct message when there is none. The stream
is dropped on error, so the next entry reopens the file and the logger recovers
on its own once the disk comes back.

A handler that throws is swallowed too — routing errors through a callback that
can crash the process would defeat the point.

## 6. Configuration is merged in layers, field by field

`defaults → config file → NODE_ENV block → environment → explicit options`.

Each layer overrides only the fields it sets. The earlier implementation
replaced whole layers: passing a single option dropped the config file and the
environment entirely, so adding `{ maxFiles: 3 }` to a working call silently
moved the log file back to the default path.

Environment variables sit above the config file, not below it, because the file
is checked into the repository and the environment is how one deployment
adjusts it without editing it. The README documented the opposite order for a
while; the code was right and the README was wrong.

## 7. Config files are JSON and loading is synchronous

`createLogger` returns a `Logger`, not a promise, because a logger is built on
the first line of a program and awaiting it would push every consumer into an
async entry point.

That rules out `logger.config.js` and `.ts`: loading them means dynamic
`import`, which is asynchronous. They were listed among the candidate filenames
for a while and silently did nothing — the loop found the file and moved on.
The list now holds only what actually loads: `logger.config.json`, `.loggerrc`,
`.loggerrc.json`.

A config file that exists but does not parse throws rather than falling back to
defaults. The fallback is the dangerous outcome: the application keeps running
and writes its logs somewhere nobody is watching.

## 8. No dependencies

`fs` and `path` are the whole import list, and the package has no runtime
dependencies. For a library that sits under everything else in a process, each
dependency is one more thing that can break a consumer's install, one more
supply-chain surface, and one more version conflict.

## 9. The published artefact is tested, not just the source

The suite runs TypeScript through ts-jest, so it never loads `dist/`. What
consumers load is the bundle behind the `exports` map — and a package can pass
every test and still be unusable: a `require` that dies on an ESM-only
dependency, a `.d.cts` that was never emitted, an entry point outside `files`.

`npm run smoke` packs the real tarball, unpacks it elsewhere, checks every path
the manifest promises, loads the package through both `require()` and
`import()`, then writes and reads back a log line. It runs in CI after the
build, and again before `npm publish`.

## 10. The bundle ships unminified, without source maps

A library is minified by whatever bundles the application. In the main
deployment target — a Nuxt server route — Nitro inlines `dist/index.js` into
its own chunk and minifies that chunk itself, so minifying here would only hand
Nitro unreadable input and produce the same output. What it would cost is a
readable stack trace for anyone running the library directly under `node` —
the layer they reach for precisely when something has already gone wrong.

The maps are dropped for a different reason: Node does not read them unless the
process was started with `--enable-source-maps`, and Nitro does not carry them
into its bundle. They were 5.9 kB of a 15.4 kB tarball, inert in every case
that matters. Unminified output keeps function names and line numbers, so a
stack trace stays readable without them — it points into `index.js` instead of
`logger.ts`.

## Known gaps

- **No level filtering.** Every call writes; there is no `level: 'warn'` that
  drops debug entries. For a file logger the cost is disk, not latency, but a
  chatty debug path currently has to be removed rather than switched off.
- **No synchronous write mode.** A `process.on('exit')` handler cannot log —
  the buffer never drains. `flush()` covers the graceful path, nothing covers
  the abrupt one.
- **The size limit is checked after the write**, so a file can exceed
  `maxFileSize` by up to one entry before rotating.
- **Rotation is not safe across processes.** Two processes writing the same
  path each keep their own size counter and rename independently. One logger
  per file per process.
- **The daily boundary follows UTC**, since the filename comes from
  `toISOString()`. A deployment that reasons in local time sees the file turn
  over mid-afternoon.
