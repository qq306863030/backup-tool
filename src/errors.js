'use strict';

/**
 * 统一错误类型
 */
class BackupError extends Error {
  constructor(message, code = 'BACKUP_ERROR', cause = null) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

class ConfigError extends BackupError {
  constructor(message, cause = null) {
    super(message, 'CONFIG_ERROR', cause);
    this.name = 'ConfigError';
  }
}

class ConnectionError extends BackupError {
  constructor(message, cause = null) {
    super(message, 'CONNECTION_ERROR', cause);
    this.name = 'ConnectionError';
  }
}

module.exports = { BackupError, ConfigError, ConnectionError };
