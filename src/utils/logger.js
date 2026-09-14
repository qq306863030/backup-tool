'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const winston = require('winston');
const { DEFAULT_LOG_DIR, HOME_DIR } = require('../paths');

let logger = null;

/**
 * 初始化日志
 * @param {object} [options] { level, dir, maxFiles, maxSize }
 * @returns {object} winston logger
 */
function initLogger(options = {}) {
  let {
    level = 'info',
    dir = DEFAULT_LOG_DIR,
    maxFiles = 30,
    maxSize = '10m',
  } = options;

  if (!dir) {
    dir = DEFAULT_LOG_DIR;
  } else if (typeof dir === 'string') {
    if (dir === '~') {
      dir = os.homedir();
    } else if (dir.startsWith('~/') || dir.startsWith('~\\')) {
      dir = path.join(os.homedir(), dir.slice(2));
    }
    if (!path.isAbsolute(dir)) {
      dir = path.resolve(HOME_DIR, dir);
    }
  }

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  logger = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ timestamp, level, message, stack }) => {
        const msg = typeof message === 'string' ? message : JSON.stringify(message);
        return `${timestamp} [${level.toUpperCase()}] ${msg}${stack ? '\n' + stack : ''}`;
      })
    ),
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({
        filename: path.join(dir, 'backup.log'),
        maxFiles,
        maxSize,
        tailable: true,
      }),
    ],
  });

  return logger;
}

/**
 * 获取全局 logger，未初始化时返回一个默认控制台 logger
 * @returns {object}
 */
function getLogger() {
  if (logger) return logger;
  logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message }) =>
        `${timestamp} [${level.toUpperCase()}] ${message}`
      )
    ),
    transports: [new winston.transports.Console()],
  });
  return logger;
}

module.exports = { initLogger, getLogger };
