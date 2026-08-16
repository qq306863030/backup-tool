#!/usr/bin/env node
'use strict';

/**
 * backup CLI 命令
 * 用法：
 *   backup start [configFilePath]   启动备份服务（通过 PM2 常驻）
 *   backup exec [configFilePath]    手动执行备份（跳过调度）
 *   backup up <server-name> <file/folder> [remote-path]   上传文件/目录到服务器（相对路径基于 upload-basedir）
 *   backup down <server-name> <file/folder> [local-path]  从服务器下载文件/目录（相对路径基于 upload-basedir）
 *   backup stop                     停止备份服务
 *   backup clear                    清除 PM2 中的实例
 *   backup reload                   重载配置并重启服务
 *   backup logs                     查看服务日志
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { HOME_DIR, DEFAULT_CONFIG_PATH, DEFAULT_LOG_DIR, DEFAULT_BACKUP_DIR, ensureHomeDir } = require('../src/paths');
const { resolveConfigPath } = require('../src/config/loader');
const { runTransfer } = require('../src/transfer');

const APP_NAME = 'backup-tool';
const SCRIPT_PATH = path.resolve(__dirname, '../src/index.js');

// 打印帮助
function printHelp() {
  console.log(`
backup - 从远程服务器(SFTP)自动拉取文件备份工具（别名: bak）

用法:
  backup start [configFilePath]   启动备份服务（常驻运行）
  backup exec [configFilePath]    手动执行备份（跳过调度，立即执行所有任务）
  backup up <server-name> <file/folder> [remote-path]   上传文件/目录到服务器
  backup down <server-name> <file/folder> [local-path]  从服务器下载文件/目录
  backup stop                     停止备份服务
  backup clear                    清除 PM2 中的实例
  backup reload                   重载配置并重启服务
  backup logs                     查看服务日志
  backup help                     显示帮助

参数:
  configFilePath  配置文件路径或名称（可选）
                  - 绝对路径 / 相对路径
                  - 文件名（在 ~/.backup-tool 下查找）
                  - 不传则使用默认 ~/.backup-tool/backup.config.json5

服务器路径解析（backup up/down）：
  - 绝对路径（以 / 开头）直接使用
  - 相对路径以配置的 upload-basedir 为基准（未配置则以服务器主目录为基准）
  - up 不传远程路径时默认上传到 upload-basedir（未配置则为服务器主目录）

目录:
  配置目录: ${HOME_DIR}
  默认配置: ${DEFAULT_CONFIG_PATH}
  日志目录: ${DEFAULT_LOG_DIR}
  备份目录: ${DEFAULT_BACKUP_DIR}
`);
}

// 检查 PM2 是否可用
function checkPm2() {
  try {
    execSync('pm2 -v', { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

// 检查服务是否在运行
function isRunning() {
  try {
    const out = execSync(`pm2 jlist`, { encoding: 'utf8' });
    const list = JSON.parse(out);
    return list.some((p) => p.name === APP_NAME && p.pm2_env.status === 'online');
  } catch (err) {
    return false;
  }
}

// 解析配置文件路径，找不到则报错
function resolveConfigOrExit(configFilePath) {
  const resolved = resolveConfigPath(configFilePath);
  if (!fs.existsSync(resolved)) {
    console.error(`[backup] 错误: 未找到配置文件 ${resolved}`);
    console.error(`[backup] 请先创建配置文件，或使用 backup start <configFilePath> 指定配置文件`);
    process.exit(1);
  }
  return resolved;
}

// start 命令
function cmdStart(configFilePath) {
  if (!checkPm2()) {
    console.error('[backup] 错误: 未检测到 PM2，请先安装: npm install -g pm2');
    process.exit(1);
  }

  ensureHomeDir();
  const configPath = resolveConfigOrExit(configFilePath);
  console.log(`[backup] 使用配置文件: ${configPath}`);

  // 通过 PM2 启动
  const cmd = `pm2 start ${JSON.stringify(SCRIPT_PATH)} --name ${APP_NAME} -- ${JSON.stringify(configPath)}`;
  try {
    execSync(cmd, { stdio: 'inherit' });
    console.log(`[backup] 服务已启动 (${APP_NAME})`);
    console.log(`[backup] 查看日志: backup logs`);
  } catch (err) {
    console.error('[backup] 启动失败:', err.message);
    process.exit(1);
  }
}

// exec 命令：跳过调度，手动执行一次所有启用的备份任务
function cmdExec(configFilePath) {
  const configPath = resolveConfigOrExit(configFilePath);
  console.log(`[backup] 使用配置文件: ${configPath}`);
  console.log('[backup] 手动执行所有启用的备份任务（跳过调度）...');
  try {
    execSync(`node ${JSON.stringify(SCRIPT_PATH)} ${JSON.stringify(configPath)}`, {
      stdio: 'inherit',
      env: { ...process.env, BACKUP_EXEC: '1' },
    });
    console.log('[backup] 备份执行完成');
  } catch (err) {
    console.error('[backup] 备份执行失败:', err.message);
    process.exit(1);
  }
}

// up 命令：上传本地文件/目录到服务器
async function cmdUp(serverName, localPath, remotePath) {
  if (!serverName || !localPath) {
    console.error('[backup] 用法: backup up <server-name> <local-file/folder> [remote-path]');
    process.exit(1);
  }
  const configPath = resolveConfigOrExit();
  try {
    console.log(`[backup] 上传: ${localPath} -> ${serverName}${remotePath ? ':' + remotePath : '（服务器主目录）'}`);
    await runTransfer(configPath, 'up', serverName, localPath, remotePath);
    console.log('[backup] 上传完成');
  } catch (err) {
    console.error('[backup] 上传失败:', err.message);
    process.exit(1);
  }
}

// down 命令：下载服务器文件/目录到本地
async function cmdDown(serverName, remotePath, localPath) {
  if (!serverName || !remotePath) {
    console.error('[backup] 用法: backup down <server-name> <remote-file/folder> [local-path]');
    process.exit(1);
  }
  const configPath = resolveConfigOrExit();
  try {
    console.log(`[backup] 下载: ${serverName}:${remotePath} -> ${localPath || '本地当前目录'}`);
    await runTransfer(configPath, 'down', serverName, remotePath, localPath);
    console.log('[backup] 下载完成');
  } catch (err) {
    console.error('[backup] 下载失败:', err.message);
    process.exit(1);
  }
}

// stop 命令
function cmdStop() {
  if (!checkPm2()) {
    console.error('[backup] 错误: 未检测到 PM2');
    process.exit(1);
  }
  try {
    execSync(`pm2 stop ${APP_NAME}`, { stdio: 'inherit' });
    execSync(`pm2 delete ${APP_NAME}`, { stdio: 'inherit' });
    console.log(`[backup] 服务已停止并移除 (${APP_NAME})`);
  } catch (err) {
    console.error('[backup] 停止失败:', err.message);
    process.exit(1);
  }
}

// clear 命令：清除 PM2 中的实例
function cmdClear() {
  if (!checkPm2()) {
    console.error('[backup] 错误: 未检测到 PM2');
    process.exit(1);
  }
  try {
    execSync(`pm2 delete ${APP_NAME}`, { stdio: 'inherit' });
    console.log(`[backup] 已清除 PM2 实例 (${APP_NAME})`);
  } catch (err) {
    console.error('[backup] 清除失败:', err.message);
    process.exit(1);
  }
}

// reload 命令：重载配置并重启
function cmdReload(configFilePath) {
  if (!checkPm2()) {
    console.error('[backup] 错误: 未检测到 PM2');
    process.exit(1);
  }
  if (!isRunning()) {
    console.error('[backup] 服务未在运行，请先执行 backup start');
    process.exit(1);
  }
  const configPath = resolveConfigOrExit(configFilePath);
  console.log(`[backup] 重载配置: ${configPath}`);
  try {
    execSync(`pm2 restart ${APP_NAME} -- ${JSON.stringify(configPath)}`, { stdio: 'inherit' });
    console.log('[backup] 服务已重载');
  } catch (err) {
    console.error('[backup] 重载失败:', err.message);
    process.exit(1);
  }
}

// logs 命令
function cmdLogs() {
  if (!checkPm2()) {
    console.error('[backup] 错误: 未检测到 PM2');
    process.exit(1);
  }
  try {
    execSync(`pm2 logs ${APP_NAME}`, { stdio: 'inherit' });
  } catch (err) {
    console.error('[backup] 查看日志失败:', err.message);
    process.exit(1);
  }
}

// 主入口
function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'start':
      cmdStart(args[1]);
      break;
    case 'exec':
      cmdExec(args[1]);
      break;
    case 'up':
      cmdUp(args[1], args[2], args[3]);
      break;
    case 'down':
      cmdDown(args[1], args[2], args[3]);
      break;
    case 'stop':
      cmdStop();
      break;
    case 'clear':
      cmdClear();
      break;
    case 'reload':
      cmdReload(args[1]);
      break;
    case 'logs':
      cmdLogs();
      break;
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      printHelp();
      break;
    default:
      console.error(`[backup] 未知命令: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main();
