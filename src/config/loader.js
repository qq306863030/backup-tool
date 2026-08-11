'use strict';

const fs = require('fs');
const path = require('path');
const JSON5 = require('json5');
const { ConfigError } = require('../errors');
const { DEFAULT_CONFIG_PATH, HOME_DIR } = require('../paths');

/**
 * 配置加载器：读取并解析 JSON5 配置文件
 */

/**
 * 解析配置文件路径
 * 支持：
 * - 绝对路径
 * - 相对路径（相对当前工作目录）
 * - 文件名（如 backup.config.json5，在 ~/.backup-tool 下查找）
 * - 未传时使用默认路径 ~/.backup-tool/backup.config.json5
 * @param {string} [configPath]
 * @returns {string} 解析后的绝对路径
 */
function resolveConfigPath(configPath) {
  if (!configPath) {
    return DEFAULT_CONFIG_PATH;
  }
  // 绝对路径直接返回
  if (path.isAbsolute(configPath)) {
    return configPath;
  }
  // 含路径分隔符或扩展名，视为相对路径
  if (configPath.includes('/') || configPath.includes('\\') || path.extname(configPath)) {
    return path.resolve(configPath);
  }
  // 否则视为文件名，在 ~/.backup-tool 下查找
  return path.join(HOME_DIR, configPath);
}

/**
 * 加载配置文件
 * @param {string} [configPath] 配置文件路径/名称
 * @returns {object} 原始用户配置
 */
function loadConfig(configPath) {
  const resolvedPath = configPath || process.env.BACKUP_CONFIG || DEFAULT_CONFIG_PATH;
  const absPath = path.resolve(resolvedPath);

  if (!fs.existsSync(absPath)) {
    throw new ConfigError(`配置文件不存在: ${absPath}`);
  }

  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    throw new ConfigError(`读取配置文件失败: ${absPath}`, err);
  }

  let parsed;
  try {
    parsed = JSON5.parse(raw);
  } catch (err) {
    throw new ConfigError(`解析 JSON5 配置失败: ${err.message}`, err);
  }

  return parsed;
}

module.exports = { loadConfig, resolveConfigPath, DEFAULT_CONFIG_PATH };
