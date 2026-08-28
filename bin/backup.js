#!/usr/bin/env node
'use strict';

/**
 * backup CLI 命令
 * 用法：
 *   backup start [configFilePath]   启动备份服务（通过 PM2 常驻）
 *   backup exec [configFilePath]    手动执行备份（跳过调度）
 *   backup push <server-name> <file/folder> [remote-path]  上传文件/目录到服务器（别名: up，相对路径基于 upload-basedir）
 *   backup pull <server-name> <file/folder> [local-path]   从服务器下载文件/目录（别名: down，相对路径基于 upload-basedir）
 *   backup stop                     停止备份服务
 *   backup clear                    清除 PM2 中的实例
 *   backup reload                   重载配置并重启服务
 *   backup logs                     查看服务日志
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { execSync } = require('child_process');
const { HOME_DIR, DEFAULT_CONFIG_PATH, DEFAULT_LOG_DIR, DEFAULT_BACKUP_DIR, ensureHomeDir } = require('../src/paths');
const { resolveConfigPath, loadConfig } = require('../src/config/loader');
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
  backup push <server-name> <file/folder> [remote-path]  上传文件/目录到服务器（别名: up）
  backup pull <server-name> <file/folder> [local-path]   从服务器下载文件/目录（别名: down）
  backup stop                     停止备份服务
  backup clear                    清除 PM2 中的实例
  backup reload                   重载配置并重启服务
  backup logs                     查看服务日志
  backup add server               交互式添加服务器配置
  backup add task                 交互式添加备份/推送任务
  backup view config [path]       在控制台打印当前配置内容
  backup view configPath          打印默认路径信息
  backup help                     显示帮助

参数:
  configFilePath  配置文件路径或名称（可选）
                  - 绝对路径 / 相对路径
                  - 文件名（在 ~/.backup-tool 下查找）
                  - 不传则使用默认 ~/.backup-tool/backup.config.json5

服务器路径解析（backup push/pull）：
  - 绝对路径（以 / 开头）直接使用
  - 相对路径以配置的 upload-basedir 为基准（未配置则以服务器主目录为基准）
  - push 不传远程路径时默认上传到 upload-basedir（未配置则为服务器主目录）

目录:
  配置目录: ${HOME_DIR}
  默认配置: ${DEFAULT_CONFIG_PATH}
  日志目录: ${DEFAULT_LOG_DIR}
  备份目录: ${DEFAULT_BACKUP_DIR}
`);
}

// 创建交互式提示
function createPrompt() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (question) => {
    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        resolve(answer);
      });
    });
  };

  const close = () => {
    rl.close();
  };

  return { prompt, close };
}

// 读取配置文件，如果不存在则返回空配置
function readConfig(configPath) {
  const resolvedPath = resolveConfigPath(configPath);
  if (!fs.existsSync(resolvedPath)) {
    return { servers: [] };
  }
  try {
    const content = fs.readFileSync(resolvedPath, 'utf8');
    const JSON5 = require('json5');
    return JSON5.parse(content);
  } catch (err) {
    console.error(`[backup] 读取配置文件失败: ${resolvedPath}`, err.message);
    return { servers: [] };
  }
}

// 写入配置文件
function writeConfig(config, configPath) {
  const resolvedPath = resolveConfigPath(configPath);
  ensureHomeDir();
  const content = JSON.stringify(config, null, 2);
  fs.writeFileSync(resolvedPath, content, 'utf8');
  console.log(`[backup] 配置已保存到: ${resolvedPath}`);
}

// backup add server 命令：交互式添加服务器配置
async function cmdAddServer(configFilePath) {
  const { prompt, close } = createPrompt();
  
  try {
    console.log('[backup] 添加服务器配置向导');
    console.log('==========================');
    console.log('请输入服务器信息（直接回车使用默认值）\n');
    
    // 基本信息
    const host = await prompt('主机地址 (必填): ');
    if (!host) {
      throw new Error('主机地址不能为空');
    }
    
    const username = await prompt('用户名 (必填): ');
    if (!username) {
      throw new Error('用户名不能为空');
    }
    
    const name = await prompt('服务器名称 (可选，直接回车使用主机地址): ') || host;
    const port = await prompt('端口 (默认 22): ') || '22';
    
    // 认证方式
    console.log('\n认证方式:');
    console.log('1. 密码认证');
    console.log('2. 私钥认证');
    const authChoice = await prompt('请选择 (1/2，默认 1): ') || '1';
    
    let authConfig = {};
    if (authChoice === '2') {
      const privateKeyPath = await prompt('私钥路径 (必填): ');
      if (!privateKeyPath) {
        throw new Error('私钥路径不能为空');
      }
      const passphrase = await prompt('私钥口令 (可选): ');
      authConfig = {
        privateKeyPath,
        ...(passphrase && { passphrase }),
      };
    } else {
      const password = await prompt('密码 (必填): ');
      if (!password) {
        throw new Error('密码不能为空');
      }
      authConfig = { password };
    }
    
    // 可选配置
    const uploadBasedir = await prompt('上传/下载基准目录 (可选，直接回车跳过): ');
    const connectTimeout = await prompt('连接超时毫秒数 (默认 10000): ') || '10000';
    const retryMax = await prompt('最大重试次数 (默认 3): ') || '3';
    const retryDelay = await prompt('重试延迟毫秒数 (默认 5000): ') || '5000';
    
    // 构建服务器配置
    const serverConfig = {
      name,
      host,
      port: parseInt(port, 10),
      username,
      ...authConfig,
      ...(uploadBasedir && { 'upload-basedir': uploadBasedir }),
      connectTimeout: parseInt(connectTimeout, 10),
      retry: {
        max: parseInt(retryMax, 10),
        delay: parseInt(retryDelay, 10),
      },
      tasks: [], // 初始为空任务列表
    };
    
    // 读取现有配置
    const config = readConfig(configFilePath);
    if (!config.servers) {
      config.servers = [];
    }
    
    // 检查服务器名称是否已存在
    const existingServer = config.servers.find(s => s.name === name);
    if (existingServer) {
      throw new Error(`服务器 "${name}" 已存在`);
    }
    
    // 添加新服务器
    config.servers.push(serverConfig);
    
    // 保存配置
    writeConfig(config, configFilePath);
    
    console.log(`\n[backup] 服务器 "${name}" 添加成功！`);
    console.log('您可以使用 "backup add task" 命令为该服务器添加任务。');
    
  } catch (err) {
    console.error('[backup] 添加服务器失败:', err.message);
    process.exit(1);
  } finally {
    close();
  }
}

// backup add task 命令：交互式添加任务配置
async function cmdAddTask(configFilePath) {
  const { prompt, close } = createPrompt();
  
  try {
    console.log('[backup] 添加任务配置向导');
    console.log('=========================');
    
    // 读取现有配置
    const config = readConfig(configFilePath);
    if (!config.servers || config.servers.length === 0) {
      throw new Error('没有找到服务器配置，请先使用 "backup add server" 添加服务器');
    }
    
    // 显示服务器列表
    console.log('可用服务器:');
    config.servers.forEach((server, index) => {
      console.log(`${index + 1}. ${server.name} (${server.host})`);
    });
    
    const serverIndexStr = await prompt('\n请选择服务器序号: ');
    const serverIndex = parseInt(serverIndexStr, 10) - 1;
    
    if (isNaN(serverIndex) || serverIndex < 0 || serverIndex >= config.servers.length) {
      throw new Error('无效的服务器序号');
    }
    
    const selectedServer = config.servers[serverIndex];
    console.log(`\n已选择服务器: ${selectedServer.name} (${selectedServer.host})`);
    
    // 任务基本信息
    const taskName = await prompt('任务名称 (必填): ');
    if (!taskName) {
      throw new Error('任务名称不能为空');
    }
    
    // 检查任务名称是否已存在
    const existingTask = selectedServer.tasks.find(t => t.name === taskName);
    if (existingTask) {
      throw new Error(`任务 "${taskName}" 在该服务器中已存在`);
    }
    
    // 任务方向
    console.log('\n任务方向:');
    console.log('1. pull (从服务器拉取到本地)');
    console.log('2. push (从本地推送到服务器)');
    const directionChoice = await prompt('请选择 (1/2，默认 1): ') || '1';
    const direction = directionChoice === '2' ? 'push' : 'pull';
    
    // 任务类型
    console.log('\n任务类型:');
    console.log('1. incremental (增量)');
    console.log('2. full (全量)');
    const typeChoice = await prompt('请选择 (1/2，默认 1): ') || '1';
    const type = typeChoice === '2' ? 'full' : 'incremental';
    
    // Cron 表达式
    const cron = await prompt('Cron 表达式 (必填，如 "0 2 * * *"): ');
    if (!cron) {
      console.error('[backup] 错误: Cron 表达式不能为空');
      process.exit(1);
    }
    
    // 源路径和目标路径
    let source, destination;
    if (direction === 'pull') {
      source = await prompt('远程源路径 (必填，如 "/data"): ');
      destination = await prompt('本地目标路径 (必填，如 "~/.backup-tool/backups/data"): ');
    } else {
      source = await prompt('本地源路径 (必填，如 "./dist"): ');
      destination = await prompt('远程目标路径 (必填，如 "/var/www"): ');
    }
    
    if (!source || !destination) {
      throw new Error('源路径和目标路径不能为空');
    }
    
    // 任务特定配置
    let taskConfig = {
      name: taskName,
      enabled: true,
      direction,
      type,
      cron,
      source,
      destination,
    };
    
    if (type === 'incremental') {
      console.log('\n增量配置:');
      const compareByStr = await prompt('比较依据 (默认 "name,size,mtime"): ') || 'name,size,mtime';
      const compareBy = compareByStr.split(',').map(s => s.trim());
      
      const deleteRemovedStr = await prompt('删除远程已删除的本地文件 (默认 false): ') || 'false';
      const deleteRemoved = deleteRemovedStr.toLowerCase() === 'true';
      
      const includeStr = await prompt('包含规则 (逗号分隔，默认空): ') || '';
      const include = includeStr ? includeStr.split(',').map(s => s.trim()) : [];
      
      const excludeStr = await prompt('排除规则 (逗号分隔，默认空): ') || '';
      const exclude = excludeStr ? excludeStr.split(',').map(s => s.trim()) : [];
      
      taskConfig.incremental = {
        compareBy,
        deleteRemoved,
        include,
        exclude,
      };
    } else {
      console.log('\n全量配置:');
      const maxBackupsStr = await prompt('最大保留份数 (默认 5): ') || '5';
      const maxBackups = parseInt(maxBackupsStr, 10);
      
      const timestampFormat = await prompt('时间戳格式 (默认 "YYYYMMDD-HHmmss"): ') || 'YYYYMMDD-HHmmss';
      
      const compressStr = await prompt('是否压缩为 zip (默认 true): ') || 'true';
      const compress = compressStr.toLowerCase() === 'true';
      
      const excludeStr = await prompt('排除规则 (逗号分隔，默认空): ') || '';
      const exclude = excludeStr ? excludeStr.split(',').map(s => s.trim()) : [];
      
      taskConfig.full = {
        maxBackups,
        timestampFormat,
        compress,
        exclude,
      };
    }
    
    // 添加任务到服务器
    if (!selectedServer.tasks) {
      selectedServer.tasks = [];
    }
    selectedServer.tasks.push(taskConfig);
    
    // 保存配置
    writeConfig(config, configFilePath);
    
    console.log(`\n[backup] 任务 "${taskName}" 添加成功！`);
    console.log(`服务器: ${selectedServer.name}`);
    console.log(`方向: ${direction}`);
    console.log(`类型: ${type}`);
    
  } catch (err) {
    console.error('[backup] 添加任务失败:', err.message);
    process.exit(1);
  } finally {
    close();
  }
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

// push 命令：上传本地文件/目录到服务器（别名: up）
async function cmdPush(serverName, localPath, remotePath) {
  if (!serverName || !localPath) {
    console.error('[backup] 用法: backup push <server-name> <local-file/folder> [remote-path]（别名: backup up）');
    process.exit(1);
  }
  const configPath = resolveConfigOrExit();
  try {
    console.log(`[backup] 上传: ${localPath} -> ${serverName}${remotePath ? ':' + remotePath : '（服务器主目录）'}`);
    await runTransfer(configPath, 'push', serverName, localPath, remotePath);
    console.log('[backup] 上传完成');
  } catch (err) {
    console.error('[backup] 上传失败:', err.message);
    process.exit(1);
  }
}

// pull 命令：下载服务器文件/目录到本地（别名: down）
async function cmdPull(serverName, remotePath, localPath) {
  if (!serverName || !remotePath) {
    console.error('[backup] 用法: backup pull <server-name> <remote-file/folder> [local-path]（别名: backup down）');
    process.exit(1);
  }
  const configPath = resolveConfigOrExit();
  try {
    console.log(`[backup] 下载: ${serverName}:${remotePath} -> ${localPath || '本地当前目录'}`);
    await runTransfer(configPath, 'pull', serverName, remotePath, localPath);
    console.log('[backup] 下载完成');
  } catch (err) {
    console.error('[backup] 下载失败:', err.message);
    process.exit(1);
  }
}

// 别名保留兼容
const cmdUp = cmdPush;
const cmdDown = cmdPull;

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

// backup view config 命令：打印当前配置内容
function cmdViewConfig(configFilePath) {
  const resolvedPath = resolveConfigPath(configFilePath);
  console.log(`[backup] 配置文件路径: ${resolvedPath}`);
  console.log('='.repeat(50));
  
  if (!fs.existsSync(resolvedPath)) {
    console.log('[backup] 配置文件不存在');
    console.log('您可以使用 "backup add server" 命令添加服务器配置');
    return;
  }
  
  try {
    const content = fs.readFileSync(resolvedPath, 'utf8');
    console.log(content);
  } catch (err) {
    console.error('[backup] 读取配置文件失败:', err.message);
  }
}

// backup view configPath 命令：打印默认路径
function cmdViewConfigPath() {
  console.log('[backup] 默认路径信息');
  console.log('='.repeat(50));
  console.log(`配置目录: ${HOME_DIR}`);
  console.log(`默认配置文件: ${DEFAULT_CONFIG_PATH}`);
  console.log(`日志目录: ${DEFAULT_LOG_DIR}`);
  console.log(`备份目录: ${DEFAULT_BACKUP_DIR}`);
  console.log('='.repeat(50));
  console.log('提示: 您可以使用 "backup view config" 查看配置内容');
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
    case 'push':
    case 'up':
      cmdPush(args[1], args[2], args[3]);
      break;
    case 'pull':
    case 'down':
      cmdPull(args[1], args[2], args[3]);
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
    case 'add':
      // 处理 add 子命令
      if (args[1] === 'server') {
        cmdAddServer(args[2]);
      } else if (args[1] === 'task') {
        cmdAddTask(args[2]);
      } else {
        console.error('[backup] 未知的 add 子命令:', args[1]);
        console.error('[backup] 可用子命令: server, task');
        process.exit(1);
      }
      break;
    case 'view':
      // 处理 view 子命令
      if (args[1] === 'config') {
        cmdViewConfig(args[2]);
      } else if (args[1] === 'configPath' || args[1] === 'config-path') {
        cmdViewConfigPath();
      } else {
        console.error('[backup] 未知的 view 子命令:', args[1]);
        console.error('[backup] 可用子命令: config, configPath');
        process.exit(1);
      }
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
