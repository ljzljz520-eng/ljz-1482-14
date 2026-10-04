import winston from "winston";
import { env } from "../config/env.js";

const baseLogger = winston.createLogger({
  level: env.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "park-media" },
  transports: [new winston.transports.Console()]
});

type Meta = Record<string, unknown>;
interface ParkLogger {
  debug: (metaOrMsg: Meta | string, message?: string) => void;
  info: (metaOrMsg: Meta | string, message?: string) => void;
  warn: (metaOrMsg: Meta | string, message?: string) => void;
  error: (metaOrMsg: Meta | string, message?: string) => void;
}

function wrap(module: string, underlying: winston.Logger): ParkLogger {
  const make =
    (level: "debug" | "info" | "warn" | "error") =>
    (metaOrMsg: Meta | string, message?: string) => {
      if (typeof metaOrMsg === "string") {
        underlying[level](message ?? metaOrMsg, message ? { module } : { module });
        return;
      }
      const msg = message ?? level;
      underlying[level](msg, { module, ...metaOrMsg });
    };
  return {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error")
  };
}

const root = wrap("app", baseLogger);
export const childLogger = (module: string): ParkLogger => wrap(module, baseLogger);
export default root;
