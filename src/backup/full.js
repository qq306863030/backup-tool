'use strict';

const path = require('path');
const { LocalStorage } = require('../storage/local-storage');
const { Retention } = require('../storage/retention');
const { zipDirectory } = require('../utils/compress');
const { buildBackupDirName, toRelativePath, safeJoin } = require('../utils/path');
const { runConcurrentPool, createAggregatedProgress, formatDurationHMS } = require('../utils/concurrent-pool');

/**
 * 全量备份引擎：每次生成带时间戳的独立副本，按 maxBackups 清理旧版本
 */
class FullBackup {
  /**
   * @param {object} logger
   */
  constructor(logger) {
    this.logger = logger;
    this.storage = new LocalStorage();
    this.retention = new Retention(logger);
  }

  /**
   * 执行全量备份
   * @param {object} connector SFTP 连接器
   * @param {object} task 内部标准任务配置
   * @returns {Promise<{backupDir: string, zipPath: string|null, removed: string[], duration: string}>}
   */
  async run(connector, task) {
    const { source, destination, name, checkConcurrency, concurrency, full } = task;
    const { maxBackups, timestampFormat, compress, exclude } = full;

    const t0 = Date.now();
    this.logger.info(`[full] ${name}: 开始全量备份 ${source} -> ${destination}`);
    this.storage.ensureDir(destination);

    // 1. 生成带时间戳的备份目录
    const backupDirName = buildBackupDirName(name, new Date(), timestampFormat);
    const backupDir = path.join(destination, backupDirName);
    this.storage.ensureDir(backupDir);

    // 2. 列出远程文件并并发下载
    const remoteFiles = await connector.listFiles(source, checkConcurrency || 8);
    const remoteFileEntries = remoteFiles.filter((f) => !f.isDirectory);

    let downloaded = 0;
    const totalBytes = remoteFileEntries.reduce((sum, f) => sum + f.size, 0);
    const progress = createAggregatedProgress(totalBytes, remoteFileEntries.length);

    await runConcurrentPool(remoteFileEntries, concurrency || 4, async (entry) => {
      const rel = toRelativePath(entry.path, source);
      const localPath = safeJoin(backupDir, rel);
      try {
        this.storage.ensureDir(path.dirname(localPath));
        let prevTransferred = 0;
        await connector.downloadResume(entry.path, localPath, entry.mtime, (transferred) => {
          const delta = transferred - prevTransferred;
          prevTransferred = transferred;
          if (delta > 0) progress.addBytes(delta);
        });
        downloaded++;
        progress.completeOneFile(rel);
      } catch (err) {
        this.logger.error(`[full] 下载失败 ${entry.path}: ${err.message}`);
      }
    });

    progress.finish();

    // 3. 可选压缩为 zip
    let zipPath = null;
    if (compress) {
      zipPath = `${backupDir}.zip`;
      await zipDirectory(backupDir, zipPath, exclude);
      // 压缩成功后删除原始目录
      this.storage.remove(backupDir);
      this.logger.info(`[full] ${name}: 已压缩为 ${zipPath}`);
    }

    // 4. 保留策略清理
    const removed = this.retention.cleanup(destination, name, maxBackups);

    const totalDuration = formatDurationHMS(Date.now() - t0);
    this.logger.info(`[full] ${name}: 全量备份全部完成！总耗时: ${totalDuration}, 下载 ${downloaded} 个文件，清理 ${removed.length} 份旧备份`);
    return { backupDir, zipPath, removed, duration: totalDuration };
  }
}

module.exports = { FullBackup };
