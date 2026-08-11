'use strict';

const path = require('path');
const { LocalStorage } = require('../storage/local-storage');
const { Retention } = require('../storage/retention');
const { zipDirectory } = require('../utils/compress');
const { buildBackupDirName, toRelativePath, safeJoin } = require('../utils/path');

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
   * @returns {Promise<{backupDir: string, zipPath: string|null, removed: string[]}>}
   */
  async run(connector, task) {
    const { source, destination, name, full } = task;
    const { maxBackups, timestampFormat, compress, exclude } = full;

    this.logger.info(`[full] ${name}: 开始全量备份 ${source} -> ${destination}`);
    this.storage.ensureDir(destination);

    // 1. 生成带时间戳的备份目录
    const backupDirName = buildBackupDirName(name, new Date(), timestampFormat);
    const backupDir = path.join(destination, backupDirName);
    this.storage.ensureDir(backupDir);

    // 2. 列出远程文件并下载
    const remoteFiles = await connector.listFiles(source);
    const remoteFileEntries = remoteFiles.filter((f) => !f.isDirectory);

    let downloaded = 0;
    for (const entry of remoteFileEntries) {
      const rel = toRelativePath(entry.path, source);
      const localPath = safeJoin(backupDir, rel);
      try {
        this.storage.ensureDir(path.dirname(localPath));
        await connector.download(entry.path, localPath, entry.mtime);
        downloaded++;
      } catch (err) {
        this.logger.error(`[full] 下载失败 ${entry.path}: ${err.message}`);
      }
    }

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

    this.logger.info(`[full] ${name}: 完成，下载 ${downloaded} 个文件，清理 ${removed.length} 份旧备份`);
    return { backupDir, zipPath, removed };
  }
}

module.exports = { FullBackup };
