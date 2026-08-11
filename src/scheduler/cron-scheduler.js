'use strict';

const cron = require('node-cron');
const { SftpConnector } = require('../connectors/sftp');
const { BackupRunner } = require('../backup');

/**
 * cron 调度器：注册/注销任务
 */
class CronScheduler {
  /**
   * @param {object} config 内部标准配置
   * @param {object} logger
   */
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.runner = new BackupRunner(logger);
    this.jobs = [];
  }

  /**
   * 注册所有任务
   */
  start() {
    for (const server of this.config.servers) {
      for (const task of server.tasks) {
        if (!task.enabled) {
          this.logger.info(`[scheduler] 跳过禁用任务 ${task.name}`);
          continue;
        }
        if (!cron.validate(task.cron)) {
          this.logger.error(`[scheduler] 任务 ${task.name} 的 cron 表达式无效: ${task.cron}`);
          continue;
        }
        const job = cron.schedule(task.cron, () => {
          this.execute(server, task);
        });
        this.jobs.push(job);
        this.logger.info(`[scheduler] 已注册任务 ${task.name} (${task.type}) cron=${task.cron}`);
      }
    }
    this.logger.info(`[scheduler] 共注册 ${this.jobs.length} 个任务`);
  }

  /**
   * 执行单个任务（串行，防止并发）
   * @param {object} server
   * @param {object} task
   */
  async execute(server, task) {
    if (task._running) {
      this.logger.warn(`[scheduler] 任务 ${task.name} 正在执行，跳过本次触发`);
      return;
    }
    task._running = true;
    const connector = new SftpConnector(server);
    try {
      this.logger.info(`[scheduler] 任务 ${task.name} 开始执行`);
      await connector.connect();
      const result = await this.runner.runTask(connector, task);
      this.logger.info(`[scheduler] 任务 ${task.name} 执行完成: ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`[scheduler] 任务 ${task.name} 执行失败: ${err.message}`);
    } finally {
      await connector.close();
      task._running = false;
    }
  }

  /**
   * 注销所有任务
   */
  stop() {
    for (const job of this.jobs) {
      job.stop();
    }
    this.jobs = [];
    this.logger.info('[scheduler] 已停止所有任务');
  }
}

module.exports = { CronScheduler };
