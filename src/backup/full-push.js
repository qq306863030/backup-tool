'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { formatTimestamp, buildBackupDirName, isBackupDir, extractTimestamp, toRelativePath, toPosixPath } = require('../utils/path');
const { compressDir } = require('../utils/compress');
const { LocalStorage } = require('../storage/local-storage');

/**
 * 全量推送引擎 (Push 模式)
 * 将本地 source 目录完整推送到远程 destination/<name>_<timestamp> 目录，或压缩上传为 .zip 文件，
 * 并自动按保留策略 (maxBackups) 清理远程历史版本。
 */
class FullPush {
  constructor(logger, storage) {
    this.logger = logger;
    this.storage = storage || new LocalStorage();
  }

  /**
   * 执行全量推送
   * @param {import('../connectors/sftp')} connector
   * @param {Object} task
   */
  async run(connector, task) {
    const { name, source, destination, full } = task;
    const { maxBackups, timestampFormat, compress, exclude } = full;

    const timestamp = formatTimestamp(new Date(), timestampFormat);
    const backupDirName = buildBackupDirName(name, timestamp);
    const remoteDestDir = toPosixPath(destination);

    this.logger.info(`[full-push] ${name}: 开始全量推送 ${source} -> ${remoteDestDir}/${backupDirName}`);

    // 1. 获取本地文件列表
    const allLocalRelPaths = this.storage.listFiles(source);
    let uploadedCount = 0;

    if (compress) {
      // 压缩模式：在本地打包为临时 .zip 文件，然后直接上传到远程目标目录
      const tmpZipPath = path.join(os.tmpdir(), `${backupDirName}.zip`);
      try {
        await compressDir(source, tmpZipPath, { exclude });
        // 确保远程目标目录存在
        await connector.ensureRemoteDir(remoteDestDir);
        const remoteZipTarget = toPosixPath(path.posix.join(remoteDestDir, `${backupDirName}.zip`));
        this.logger.info(`[full-push] ${name}: 上传压缩包 ${tmpZipPath} -> ${remoteZipTarget}`);
        await connector.uploadResume(tmpZipPath, remoteZipTarget);
        uploadedCount = allLocalRelPaths.length;
      } finally {
        if (fs.existsSync(tmpZipPath)) {
          fs.unlinkSync(tmpZipPath);
        }
      }
    } else {
      // 非压缩模式：在远程创建版本目录，逐个上传文件
      const remoteTargetBase = toPosixPath(path.posix.join(remoteDestDir, backupDirName));
      await connector.ensureRemoteDir(remoteTargetBase);
      for (const rel of allLocalRelPaths) {
        const localFullPath = path.resolve(source, rel);
        const remoteTarget = toPosixPath(path.posix.join(remoteTargetBase, toPosixPath(rel)));
        // 确保远程子目录存在（处理源目录有嵌套子目录的情况）
        const remoteParentDir = toPosixPath(path.posix.dirname(remoteTarget));
        if (remoteParentDir !== remoteTargetBase) {
          await connector.ensureRemoteDir(remoteParentDir);
        }
        await connector.uploadResume(localFullPath, remoteTarget);
        uploadedCount++;
      }
    }

    // 2. 执行远程保留策略清理 (Remote Retention)
    const cleanedCount = await this._cleanRemoteRetention(connector, remoteDestDir, name, maxBackups);

    this.logger.info(
      `[full-push] ${name}: 全量推送完成, 目标: ${remoteDestDir}/${backupDirName}, 上传文件数: ${uploadedCount}, 清理旧版本数: ${cleanedCount}`
    );

    return {
      uploadedCount,
      cleanedCount,
      targetDir: `${remoteDestDir}/${backupDirName}`,
    };
  }

  /**
   * 清理远程过期的历史备份版本
   * connector.listFiles 返回 {name, path, size, mtime, isDirectory}
   */
  async _cleanRemoteRetention(connector, remoteDestDir, taskName, maxBackups) {
    if (!maxBackups || maxBackups <= 0) return 0;

    let entries = [];
    try {
      entries = await connector.listFiles(remoteDestDir);
    } catch (err) {
      this.logger.warn(`[full-push] ${taskName}: 列出远程目录失败，跳过清理: ${err.message}`);
      return 0;
    }

    const backups = [];
    for (const entry of entries) {
      // 只处理顶层条目（直接位于 remoteDestDir 下的文件或目录）
      const relPath = toRelativePath(entry.path, remoteDestDir);
      if (relPath.includes('/') || relPath.includes('\\')) continue;

      const isDir = entry.isDirectory;
      const isZip = !isDir && entry.name.endsWith('.zip');
      if (!isDir && !isZip) continue;

      const baseName = isZip ? entry.name.slice(0, -4) : entry.name;
      if (!isBackupDir(baseName, taskName)) continue;
      const ts = extractTimestamp(baseName, taskName);
      if (!ts) continue;

      backups.push({
        name: entry.name,
        timestamp: ts,
        fullPath: toPosixPath(entry.path),
        isDir,
      });
    }

    // 按时间戳升序排序（最旧的在前面）
    backups.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

    const toDeleteCount = backups.length - maxBackups;
    if (toDeleteCount <= 0) return 0;

    const toDelete = backups.slice(0, toDeleteCount);
    let cleaned = 0;

    for (const item of toDelete) {
      this.logger.info(`[full-push] [retention] ${taskName}: 清理远程旧版本 ${item.name}`);
      try {
        if (item.isDir) {
          await connector.deleteDir(item.fullPath);
        } else {
          await connector.deleteFile(item.fullPath);
        }
        cleaned++;
      } catch (err) {
        this.logger.warn(`[full-push] [retention] ${taskName}: 清理远程旧版本失败 ${item.fullPath}: ${err.message}`);
      }
    }

    return cleaned;
  }
}

module.exports = { FullPush };
