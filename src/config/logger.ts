import chalk from "chalk";
import { LOG_LEVEL } from "@/config/env.ts";

export enum LogLevel {
  FATAL = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
  TRACE = 5,
}

class Logger {
  constructor(private level: LogLevel) {}

  private format(args: unknown[]): string {
    return args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        try {
          return chalk.cyan(JSON.stringify(arg));
        } catch (err) {
          return chalk.cyan(`[Unstringifiable: ${(err as Error).message}]`);
        }
      })
      .join(" ");
  }

  private write(level: LogLevel, color: typeof chalk.blue, ...args: unknown[]) {
    if (this.level < level) return;
    const ts = new Date().toISOString();
    const prefix = chalk.gray(`[${ts}::${LogLevel[level]}]`);
    console.log(`${prefix} ${color(this.format(args))}`);
  }

  trace(...args: unknown[]) {
    this.write(LogLevel.TRACE, chalk.white, ...args);
  }
  debug(...args: unknown[]) {
    this.write(LogLevel.DEBUG, chalk.green, ...args);
  }
  info(...args: unknown[]) {
    this.write(LogLevel.INFO, chalk.blue, ...args);
  }
  warn(...args: unknown[]) {
    this.write(LogLevel.WARN, chalk.yellow, ...args);
  }
  error(...args: unknown[]) {
    this.write(LogLevel.ERROR, chalk.red, ...args);
  }
  fatal(...args: unknown[]) {
    this.write(LogLevel.FATAL, chalk.bgRed.white, ...args);
  }
}

const resolvedLevel = LogLevel[LOG_LEVEL as keyof typeof LogLevel] ??
  LogLevel.INFO;

export const LOG = new Logger(resolvedLevel);
