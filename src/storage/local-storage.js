'use strict';

const fs = require('fs');
const path = require('path');
const { safeJoin } = require('../utils/path');

/**
 * 本地存储：负责本地目录的读写与清理
 */
class LocalStorage {
  /**
   * 确保目录存在
   * @param {string} dir
   */
  ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * 获取本地文件信息
   * @param {string} filePath
   * @returns {object|null} { size, mtime } 或 null
   */
  stat(filePath) {
    try {
      const st = fs.statSync(filePath);
      return { size: st.size, mtime: st.mtime };
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * 列出目录下的所有文件（递归）
   * @param {string} dir
   * @returns {string[]} 相对路径列表
   */
  listFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    const result = [];
    const walk = (current, rel) => {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        const relPath = rel ? path.join(rel, entry.name) : entry.name;
        if (entry.isDirectory()) {
          walk(full, relPath);
        } else {
          result.push(relPath);
        }
      }
    };
    walk(dir, '');
    return result;
  }

  /**
   * 删除文件或目录
   * @param {string} target
   */
  remove(target) {
    fs.rmSync(target, { recursive: true, force: true });
  }

  /**
   * 列出目标目录下属于某任务的备份（目录或 zip 文件）
   * @param {string} destination 目标目录
   * @param {string} name 任务名称
   * @returns {Array<{dirName, fullPath, timestamp, isZip}>} 按时间戳升序
   */
  listBackupDirs(destination, name) {
    const { isBackupDir, extractTimestamp } = require('../utils/path');
    if (!fs.existsSync(destination)) return [];
    const entries = fs.readdirSync(destination, { withFileTypes: true });
    const backups = [];
    for (const entry of entries) {
      // 支持目录（未压缩）和 .zip 文件（已压缩）
      const isDir = entry.isDirectory();
      const isZip = entry.isFile() && entry.name.endsWith('.zip');
      if (!isDir && !isZip) continue;

      // 去掉 .zip 后缀再判断
      const baseName = isZip ? entry.name.slice(0, -4) : entry.name;
      if (!isBackupDir(baseName, name)) continue;
      const timestamp = extractTimestamp(baseName, name);
      if (!timestamp) continue;
      backups.push({
        dirName: entry.name,
        fullPath: path.join(destination, entry.name),
        timestamp,
        isZip,
      });
    }
    // 按时间戳升序（最老在前）
    backups.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    return backups;
  }
}

module.exports = { LocalStorage };
