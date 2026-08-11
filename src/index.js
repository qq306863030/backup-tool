'use strict';

const { loadConfig } = require('./config/loader');
const { adaptConfig } = require('./config/adapter');
const { validateConfig } = require('./config/schema');
const { initLogger, getLogger } = require('./utils/logger');
const { CronScheduler } = require('./scheduler/cron-scheduler');
const { ensureHomeDir } = require('./paths');

/**
 * 程序入口：加载配置 → 适配 → 校验 → 启动调度器
 * @param {string} [configPath] 配置文件路径/名称
 */
async function main(configPath) {
  // 确保 ~/.backup-tool 目录存在
  ensureHomeDir();

  let config;
  try {
    const raw = loadConfig(configPath);
    config = adaptConfig(raw);
    validateConfig(config);
  } catch (err) {
    // 配置错误时用默认 logger 输出并退出
    const logger = getLogger();
    logger.error(`配置加载失败: ${err.message}`);
    process.exit(1);
  }

  const logger = initLogger(config.log);
  logger.info('备份工具启动');

  const scheduler = new CronScheduler(config, logger);
  scheduler.start();

  // 优雅退出
  const shutdown = () => {
    logger.info('收到退出信号，正在停止...');
    scheduler.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return scheduler;
}

// 直接运行时启动，支持传入配置文件路径
if (require.main === module) {
  const configPath = process.argv[2];
  main(configPath).catch((err) => {
    const logger = getLogger();
    logger.error(`启动失败: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
