import pino from 'pino';

/**
 * One shared structured logger. Pretty-prints to stdout in development,
 * plain JSON lines in production (easy to ship to a log aggregator without
 * a separate parsing step). Replaces the scattered console.log calls that
 * were previously the only signal of what the backend was doing.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
});
