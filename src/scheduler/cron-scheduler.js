'use strict';

const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { SftpConnector } = require('../connectors/sftp');
const { BackupRunner } = require('../backup');
const { formatDurationHMS } = require('../utils/concurrent-pool');
const { DEFAULT_LOG_DIR } = require('../paths');

/**
 * 当前正在执行的任务（用于识别「传输中途进程异常退出」）
 * 传输中断线且挂起 Promise 永不落定时，事件循环会被清空，
 * Node 会以退出码 0 静默退出，外层 bak exec 便误报「备份执行完成」。
 */
let activeTask = null;
let exitGuardInstalled = false;
let exitGuardLogFile = null;

/**
 * 安装进程退出守卫：任务未结束却已经无事可做时，同步落盘一条 FATAL 并以退出码 1 结束
 * @param {string} [logFile] 主日志文件路径（用于同步写入，exit 阶段只有同步 IO 可靠）
 */
function installExitGuard(logFile) {
  if (logFile) exitGuardLogFile = logFile;
  if (exitGuardInstalled) return;
  exitGuardInstalled = true;

  process.on('beforeExit', () => {
    if (!activeTask) return; // 正常结束：没有任务在执行
    const runningFor = formatDurationHMS(Date.now() - activeTask.startedAt);
    const msg =
      `任务 ${activeTask.name} 尚未结束（已运行 ${runningFor}），进程却已无事可做：` +
      '疑似连接假死或挂起 Promise 永不落定导致事件循环空转。已强制以退出码 1 结束，避免误报成功。';
    const line = `${new Date().toISOString()} [ERROR] [scheduler] ${msg}`;
    try {
      if (exitGuardLogFile) fs.appendFileSync(exitGuardLogFile, line + '\n');
    } catch (_) {}
    try {
      process.stderr.write(`\n[backup] ${line}\n`);
    } catch (_) {}
    process.exit(1);
  });
}

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
          // execute 内部已兜住异常并返回状态，这里再挂一层防御，避免 unhandledRejection
          Promise.resolve(this.execute(server, task)).catch((err) => {
            this.logger.error(`[scheduler] 任务 ${task.name} 调度执行异常: ${err.message}`);
          });
        });
        this.jobs.push(job);
        this.logger.info(`[scheduler] 已注册任务 ${task.name} (${task.type}) cron=${task.cron}`);
      }
    }
    this.logger.info(`[scheduler] 共注册 ${this.jobs.length} 个任务`);
  }

  /**
   * 执行单个任务（串行，防止并发）
   *
   * 注意：本方法**不抛异常**，而是返回状态对象，便于 backup exec 正确设置退出码。
   * @param {object} server
   * @param {object} task
   * @returns {Promise<{ok: boolean, taskName: string, durationHMS?: string, result?: object, error?: string, skipped?: boolean}>}
   */
  async execute(server, task) {
    if (task._running) {
      this.logger.warn(`[scheduler] 任务 ${task.name} 正在执行，跳过本次触发`);
      return { ok: false, skipped: true, taskName: task.name, error: '任务正在执行中，已跳过' };
    }
    task._running = true;
    activeTask = { name: task.name, startedAt: Date.now() };
    installExitGuard(path.join((this.config && this.config.log && this.config.log.dir) || DEFAULT_LOG_DIR, 'backup.log'));

    let connector = null;
    const t0 = Date.now();
    try {
      connector = new SftpConnector(server);
      this.logger.info(`[scheduler] 任务 ${task.name} 开始执行`);
      await connector.connect();
      const result = await this.runner.runTask(connector, task);
      const durationHMS = formatDurationHMS(Date.now() - t0);
      this.logger.info(`[scheduler] 任务 ${task.name} 执行完成（总耗时: ${durationHMS}）: ${JSON.stringify(result)}`);
      return { ok: true, taskName: task.name, durationHMS, result };
    } catch (err) {
      const durationHMS = formatDurationHMS(Date.now() - t0);
      this.logger.error(`[scheduler] 任务 ${task.name} 执行失败（耗时: ${durationHMS}）: ${err.message}`);
      return { ok: false, taskName: task.name, durationHMS, error: err.message };
    } finally {
      if (connector) {
        try {
          await connector.close();
        } catch (err) {
          this.logger.warn(`[scheduler] 关闭 SFTP 连接失败: ${err.message}`);
        }
      }
      task._running = false;
      activeTask = null;
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
