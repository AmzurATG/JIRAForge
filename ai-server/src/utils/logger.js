const winston = require('winston');
const { createSanitizeFormat, isEnabled, getLevel } = require('./log-sanitizer');

// Log sanitization status on startup
const sanitizeEnabled = isEnabled();
const sanitizeLevel = getLevel();

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    // Apply sanitization first to redact PII before any formatting
    createSanitizeFormat(),
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'ai-analysis-server' },
  transports: [
    // Write all logs with importance level of `error` or less to `error.log`
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    // Write all logs with importance level of `info` or less to `combined.log`
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

// Log sanitization configuration (this log itself will be sanitized)
if (process.env.NODE_ENV !== 'test') {
  console.log(`[Logger] PII Sanitization: ${sanitizeEnabled ? 'ENABLED' : 'DISABLED'} | Level: ${sanitizeLevel}`);
}

// If we're not in production, log to the console as well
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

module.exports = logger;
