'use strict';

const { IncrementalBackup } = require('./incremental');
const { FullBackup } = require('./full');

/**
 * 备份引擎分发：根据任务 type 选择引擎
 */
class BackupRunner {
  /**
   * @param {object} logger
   */
  constructor(logger) {
    this.logger = logger;
    this.incremental = new IncrementalBackup(logger);
    this.full = new FullBackup(logger);
  }

  /**
   * 执行单个任务
   * @param {object} connector SFTP 连接器
   * @param {object} task 内部标准任务配置
   * @returns {Promise<object>} 执行结果
   */
  async runTask(connector, task) {
    if (task.type === 'incremental') {
      return this.incremental.run(connector, task);
    }
    if (task.type === 'full') {
      return this.full.run(connector, task);
    }
    throw new Error(`未知任务类型: ${task.type}`);
  }
}

module.exports = { BackupRunner };
