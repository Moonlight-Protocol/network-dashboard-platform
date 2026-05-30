// Draft Logger module — TypeScript port of github.com/AquiGorka/go-logger.
// Lives at src/utils/logger/index.ts in each backend repo.

import chalk from "chalk";

export enum Level {
  Debug = 0,
  Info = 1,
  Event = 2,
  Disabled = 3,
}

export interface Logger {
  info(msg: string): void;
  event(msg: string): void;
  debug(key: string, value: unknown): void;
  error(err: unknown, msg: string): void;
  scope(name: string): Logger;
}

export interface Writer {
  write(line: string): void;
}

export interface LoggerOptions {
  /** Custom stdout writer. Replaces console.log. Useful for tests. */
  writer?: Writer;
  /** Opt-in file path for JSON-formatted records. Created if missing. */
  file?: string;
}

interface Record {
  ts: string;
  level: "debug" | "info" | "event" | "error";
  scope: string;
  msg?: string;
  key?: string;
  value?: unknown;
  error?: string;
}

type Format = (r: Record) => string;

interface Sink {
  writer: Writer;
  format: Format;
}

export function parseLevel(s: string | undefined): Level {
  switch ((s ?? "").toLowerCase()) {
    case "debug":
      return Level.Debug;
    case "info":
      return Level.Info;
    case "event":
      return Level.Event;
    default:
      return Level.Disabled;
  }
}

const stdoutWriter: Writer = {
  write: (line) => console.log(line),
};

class FileWriter implements Writer {
  private file: Deno.FsFile;
  constructor(path: string) {
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) Deno.mkdirSync(dir, { recursive: true });
    this.file = Deno.openSync(path, {
      append: true,
      create: true,
      write: true,
    });
  }
  write(line: string): void {
    this.file.writeSync(new TextEncoder().encode(line + "\n"));
  }
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.message;
  try {
    return JSON.stringify(v);
  } catch (err) {
    return `[Unstringifiable: ${(err as Error).message}]`;
  }
}

function humanFormat(colored: boolean): Format {
  const grayLb = colored ? chalk.gray : (s: string) => s;
  const greenLb = colored ? chalk.green : (s: string) => s;
  const whiteLb = colored ? chalk.white : (s: string) => s;
  const cyanLb = colored ? chalk.cyan : (s: string) => s;
  const redLb = colored ? chalk.red : (s: string) => s;

  return (r) => {
    const ts = grayLb(`[${r.ts}]`);
    switch (r.level) {
      case "info":
        return `${ts} ${greenLb("INF")} [${r.scope}] ${r.msg}`;
      case "event":
        return `${ts} ${whiteLb("EVT")} -${r.msg} (${r.scope})`;
      case "debug":
        return `${ts} ${cyanLb("DBG")}  ${r.key}: ${
          stringify(r.value)
        } (${r.scope})`;
      case "error":
        return `${ts} ${redLb("ERR")} [${r.scope}] ${r.msg} error="${r.error}"`;
    }
  };
}

const jsonFormat: Format = (r) => {
  // Stable schema. Only the fields relevant to each level are emitted.
  const out: Record = {
    ts: r.ts,
    level: r.level,
    scope: r.scope,
  };
  if (r.msg !== undefined) out.msg = r.msg;
  if (r.key !== undefined) out.key = r.key;
  if (r.value !== undefined) out.value = safeJsonValue(r.value);
  if (r.error !== undefined) out.error = r.error;
  try {
    return JSON.stringify(out);
  } catch (err) {
    return JSON.stringify({
      ts: r.ts,
      level: r.level,
      scope: r.scope,
      msg: `[unserializable record: ${(err as Error).message}]`,
    });
  }
};

function safeJsonValue(v: unknown): unknown {
  // BigInt + circular refs would break JSON.stringify. Coerce to string when
  // we can't keep the structured value.
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Error) return { message: v.message, name: v.name };
  if (v === null || typeof v !== "object") return v;
  try {
    JSON.stringify(v);
    return v;
  } catch {
    return stringify(v);
  }
}

class LoggerImpl implements Logger {
  constructor(
    private readonly level: Level,
    private readonly sinks: Sink[],
    private readonly scopePath: string,
  ) {}

  info(msg: string): void {
    if (this.level > Level.Info) return;
    this.emit({ ts: now(), level: "info", scope: this.scopePath, msg });
  }

  event(msg: string): void {
    if (this.level > Level.Event) return;
    this.emit({ ts: now(), level: "event", scope: this.scopePath, msg });
  }

  debug(key: string, value: unknown): void {
    if (this.level > Level.Debug) return;
    this.emit({ ts: now(), level: "debug", scope: this.scopePath, key, value });
  }

  error(err: unknown, msg: string): void {
    // ERR always emits regardless of level (matches go-logger / zerolog).
    const detail = err instanceof Error ? err.message : String(err);
    this.emit({
      ts: now(),
      level: "error",
      scope: this.scopePath,
      msg,
      error: detail,
    });
  }

  scope(name: string): Logger {
    return new LoggerImpl(this.level, this.sinks, `${this.scopePath}.${name}`);
  }

  private emit(r: Record): void {
    for (const sink of this.sinks) {
      sink.writer.write(sink.format(r));
    }
  }
}

function now(): string {
  return new Date().toISOString();
}

export function newLogger(level: Level, opts: LoggerOptions = {}): Logger {
  const sinks: Sink[] = [];

  // stdout sink — always present. Human format. Colored when TTY (and only
  // when caller did not pass a custom writer; tests get plain output).
  const consoleWriter = opts.writer ?? stdoutWriter;
  const colored = opts.writer === undefined && Deno.stdout.isTerminal();
  sinks.push({ writer: consoleWriter, format: humanFormat(colored) });

  // file sink — opt-in. JSON format.
  if (opts.file !== undefined) {
    sinks.push({ writer: new FileWriter(opts.file), format: jsonFormat });
  }

  return new LoggerImpl(level, sinks, "main");
}

class NoopLogger implements Logger {
  info(): void {}
  event(): void {}
  debug(): void {}
  error(): void {}
  scope(): Logger {
    return this;
  }
}

export function newNoop(): Logger {
  return new NoopLogger();
}
