'use strict';

/**
 * 整体功能测试脚本：连接真实 SFTP 服务器
 * 测试：
 * 1. SFTP 连接
 * 2. 增量备份（文件 /roman/clash.tar）
 * 3. 全量备份（目录 /roman/frp/）
 */
const { loadConfig } = require('../src/config/loader');
const { adaptConfig } = require('../src/config/adapter');
const { validateConfig } = require('../src/config/schema');
const { initLogger } = require('../src/utils/logger');
const { SftpConnector } = require('../src/connectors/sftp');
const { BackupRunner } = require('../src/backup');

async function main() {
  const raw = loadConfig();
  const config = adaptConfig(raw);
  validateConfig(config);
  const logger = initLogger({ ...config.log, level: 'info' });

  const server = config.servers[0];
  logger.info(`=== 测试服务器 ${server.host} ===`);

  // 1. 测试连接
  const connector = new SftpConnector(server);
  await connector.connect();
  logger.info('✅ SFTP 连接成功');

  // 2. 测试列出文件
  for (const task of server.tasks) {
    logger.info(`--- 任务: ${task.name} (${task.type}) ---`);
    const files = await connector.listFiles(task.source);
    logger.info(`远程路径 ${task.source} 下共 ${files.length} 个文件`);
    for (const f of files.slice(0, 5)) {
      logger.info(`  ${f.path} (${f.size} bytes, mtime=${f.mtime})`);
    }
  }

  // 3. 执行所有任务
  const runner = new BackupRunner(logger);
  for (const task of server.tasks) {
    logger.info(`=== 执行任务: ${task.name} (${task.type}) ===`);
    const result = await runner.runTask(connector, task);
    logger.info(`任务 ${task.name} 结果: ${JSON.stringify(result)}`);
  }

  await connector.close();
  logger.info('✅ 整体功能测试完成');
}

main().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
