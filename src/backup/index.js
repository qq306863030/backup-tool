'use strict';

const { IncrementalBackup } = require('./incremental');
const { FullBackup } = require('./full');
const { IncrementalPush } = require('./incremental-push');
const { FullPush } = require('./full-push');

/**
 * 备份/推送引擎分发：根据任务 direction 和 type 选择引擎
 */
class BackupRunner {
  /**
   * @param {object} logger
   */
  constructor(logger) {
    this.logger = logger;
    this.incremental = new IncrementalBackup(logger);
    this.full = new FullBackup(logger);
    this.incrementalPush = new IncrementalPush(logger);
    this.fullPush = new FullPush(logger);
  }

  /**
   * 执行单个任务
   * @param {object} connector SFTP 连接器
   * @param {object} task 内部标准任务配置
   * @returns {Promise<object>} 执行结果
   */
  async runTask(connector, task) {
    const direction = task.direction || 'pull';

    if (direction === 'push') {
      if (task.type === 'incremental') {
        return this.incrementalPush.run(connector, task);
      }
      if (task.type === 'full') {
        return this.fullPush.run(connector, task);
      }
    } else {
      if (task.type === 'incremental') {
        return this.incremental.run(connector, task);
      }
      if (task.type === 'full') {
        return this.full.run(connector, task);
      }
    }

    throw new Error(`未知任务类型或方向: direction=${direction}, type=${task.type}`);
  }
}

module.exports = { BackupRunner };
