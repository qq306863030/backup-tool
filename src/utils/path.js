'use strict';

const path = require('path');
const dayjs = require('dayjs');

/**
 * 路径与时间戳工具函数
 */

/**
 * 生成时间戳字符串
 * @param {Date|string|number} [date] 日期，默认当前时间
 * @param {string} [format] 格式，默认 YYYYMMDD-HHmmss
 * @returns {string}
 */
function formatTimestamp(date = new Date(), format = 'YYYYMMDD-HHmmss') {
  return dayjs(date).format(format);
}

/**
 * 生成全量备份的目录名：<name>_<时间戳>
 * @param {string} name 任务名称
 * @param {Date} [date]
 * @param {string} [format]
 * @returns {string}
 */
function buildBackupDirName(name, date = new Date(), format = 'YYYYMMDD-HHmmss') {
  return `${name}_${formatTimestamp(date, format)}`;
}

/**
 * 从备份目录名中解析出时间戳部分
 * 例如 "nginx_20260811-030000" -> "20260811-030000"
 * @param {string} dirName 备份目录名
 * @param {string} name 任务名称
 * @returns {string|null} 时间戳，解析失败返回 null
 */
function extractTimestamp(dirName, name) {
  const prefix = `${name}_`;
  if (!dirName.startsWith(prefix)) return null;
  return dirName.slice(prefix.length);
}

/**
 * 判断目录名是否属于某个任务的备份（以 name_ 开头）
 * @param {string} dirName
 * @param {string} name
 * @returns {boolean}
 */
function isBackupDir(dirName, name) {
  return dirName.startsWith(`${name}_`);
}

/**
 * 安全拼接路径，防止路径穿越
 * @param {string} base 基础目录
 * @param {string} relative 相对路径
 * @returns {string}
 */
function safeJoin(base, relative) {
  const resolved = path.resolve(base, relative);
  const baseResolved = path.resolve(base);
  if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
    throw new Error(`路径越界: ${relative}`);
  }
  return resolved;
}

/**
 * 将远程路径转换为本地相对路径（去掉 source 前缀）
 * 若 source 是单个文件，则返回该文件的文件名
 * @param {string} remotePath 远程完整路径
 * @param {string} source 远程源路径（文件或目录）
 * @returns {string} 相对路径
 */
function toRelativePath(remotePath, source) {
  const normalizedSource = source.replace(/\/+$/, '');
  if (remotePath === normalizedSource) {
    // source 是单个文件时，返回文件名
    return path.basename(remotePath);
  }
  if (remotePath.startsWith(normalizedSource + '/')) {
    return remotePath.slice(normalizedSource.length + 1);
  }
  return remotePath;
}

module.exports = {
  formatTimestamp,
  buildBackupDirName,
  extractTimestamp,
  isBackupDir,
  safeJoin,
  toRelativePath,
};
