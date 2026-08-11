'use strict';

const { LocalStorage } = require('./local-storage');

/**
 * 保留策略：全量备份清理旧版本
 */
class Retention {
  /**
   * @param {object} logger
   */
  constructor(logger) {
    this.logger = logger;
    this.storage = new LocalStorage();
  }

  /**
   * 清理超出 maxBackups 的旧备份
   * @param {string} destination 目标目录
   * @param {string} name 任务名称
   * @param {number} maxBackups 最大保留份数
   * @param {boolean} [dryRun] 预览模式，不实际删除
   * @returns {string[]} 被删除的目录名列表
   */
  cleanup(destination, name, maxBackups, dryRun = false) {
    const backups = this.storage.listBackupDirs(destination, name);
    const removed = [];

    if (backups.length <= maxBackups) {
      this.logger.info(`[retention] ${name}: 当前 ${backups.length} 份，未超过上限 ${maxBackups}`);
      return removed;
    }

    const toRemove = backups.slice(0, backups.length - maxBackups);
    for (const backup of toRemove) {
      if (dryRun) {
        this.logger.info(`[retention] ${name}: (dryRun) 将删除 ${backup.dirName}`);
      } else {
        this.storage.remove(backup.fullPath);
        this.logger.info(`[retention] ${name}: 已删除旧备份 ${backup.dirName}`);
      }
      removed.push(backup.dirName);
    }
    return removed;
  }
}

module.exports = { Retention };
