'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * 全局路径常量：默认配置与日志目录统一放在 ~/.backup-tool
 */

// ~/.backup-tool 主目录
const HOME_DIR = path.join(os.homedir(), '.backup-tool');

// 默认配置文件路径
const DEFAULT_CONFIG_PATH = path.join(HOME_DIR, 'backup.config.json5');

// 默认日志目录
const DEFAULT_LOG_DIR = path.join(HOME_DIR, 'logs');

// 默认备份输出目录
const DEFAULT_BACKUP_DIR = path.join(HOME_DIR, 'backups');

/**
 * 确保目录存在
 * @param {string} dir
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 确保 ~/.backup-tool 主目录存在
 */
function ensureHomeDir() {
  ensureDir(HOME_DIR);
}

module.exports = {
  HOME_DIR,
  DEFAULT_CONFIG_PATH,
  DEFAULT_LOG_DIR,
  DEFAULT_BACKUP_DIR,
  ensureDir,
  ensureHomeDir,
};
