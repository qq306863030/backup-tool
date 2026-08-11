# lite-backup-tool

> A lightweight SFTP backup tool supporting incremental and full backups.
> 一个轻量级的 SFTP 备份工具，支持增量备份与全量备份。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)

---

## Features / 功能特性

- 🔄 **Incremental backup / 增量备份**: Only downloads changed files by comparing name, size, and modification time. 通过文件名称、大小、修改时间智能判断，只下载有差异的文件。
- 📦 **Full backup / 全量备份**: Creates timestamped snapshots and auto-cleans old versions (by `maxBackups`). 每次生成带时间戳的独立副本，支持自动清理旧版本（按 `maxBackups` 保留）。
- 🔐 **SFTP support / SFTP 支持**: Supports password and private key authentication (auto-detected). 支持密码认证和私钥认证（自动判断）。
- ⏰ **Cron scheduling / Cron 调度**: Uses standard cron expressions for flexible scheduling. 使用标准 cron 表达式灵活设置任务执行时间。
- 🛡️ **PM2 daemon / PM2 常驻**: Process guard, auto-restart, and memory monitoring. 进程守护、崩溃自动重启、内存监控。
- 📝 **JSON5 config / JSON5 配置**: Supports comments, trailing commas, and single quotes. 支持注释、尾逗号、单引号，运维友好。
- 🗜️ **ZIP compression / ZIP 压缩**: Full backups are auto-compressed to zip. 全量备份自动压缩为 zip，节省存储空间。
- 🎯 **Filter rules / 过滤规则**: Incremental backup supports `include`/`exclude` glob filters (include takes priority). 增量备份支持 `include`/`exclude` glob 过滤（include 优先）。

---

## Quick Start / 快速开始

### 1. Install / 安装

Install `lite-backup-tool` globally (PM2 is bundled as a dependency, no extra setup needed):
全局安装 `lite-backup-tool`（PM2 已作为依赖自动安装，无需额外配置）：

```bash
npm install lite-backup-tool -g -verbose
```

> Requires **Node.js >= 18**. / 要求 **Node.js >= 18**。

### 2. Create config file / 创建配置文件

Create a config file at `~/.backup-tool/backup.config.json5` (the directory is auto-created on first `backup start`):
在 `~/.backup-tool/backup.config.json5` 创建配置文件（首次运行 `backup start` 会自动创建该目录）：

```json5
{
  servers: [
    {
      host: "192.168.1.100",
      username: "root",
      password: "your-password",

      tasks: [
        // Incremental backup: sync files at 2 AM daily / 增量备份：每天凌晨 2 点同步文件
        {
          name: "data",
          type: "incremental",
          cron: "0 2 * * *",
          source: "/data",
          destination: "~/.backup-tool/backups/data",
        },
        // Full backup: full backup at 3 AM every Sunday / 全量备份：每周日凌晨 3 点全量备份目录
        {
          name: "config",
          type: "full",
          cron: "0 3 * * 0",
          source: "/etc/nginx",
          destination: "~/.backup-tool/backups/nginx",
          full: {
            maxBackups: 5,
            compress: true,
          },
        },
      ],
    },
  ],
}
```

### 3. Start the service / 启动服务

```bash
# Use default config ~/.backup-tool/backup.config.json5 / 使用默认配置文件
backup start

# Specify a config file / 指定配置文件
backup start /path/to/your-config.json5
backup start my-config.json5  # searched in ~/.backup-tool / 在 ~/.backup-tool 下查找
```

---

## Commands / 命令说明

| Command / 命令 | Description / 说明 |
|------|------|
| `backup start [configFilePath]` | Start backup service (PM2 daemon) / 启动备份服务（通过 PM2 常驻运行） |
| `backup stop` | Stop backup service / 停止备份服务 |
| `backup clear` | Clear PM2 instance / 清除 PM2 中的实例 |
| `backup reload [configFilePath]` | Reload config and restart / 重载配置并重启服务 |
| `backup logs` | View service logs / 查看服务日志 |
| `backup help` | Show help / 显示帮助信息 |

### Config file path resolution / 配置文件路径解析规则

The `configFilePath` argument of `backup start` / `backup reload` supports:
`backup start` / `backup reload` 命令的 `configFilePath` 参数支持以下形式：

1. **Absolute path / 绝对路径**: `backup start /etc/backup/my-config.json5`
2. **Relative path / 相对路径**: `backup start ./configs/backup.json5`
3. **File name / 文件名**: `backup start my-config.json5` (searched in `~/.backup-tool/` / 在 `~/.backup-tool/` 下查找)
4. **No argument / 不传参数**: uses default `~/.backup-tool/backup.config.json5` / 使用默认路径

If the config file does not exist, an error is reported and the process exits.
如果配置文件不存在，会报错并退出。

### Directory structure / 目录结构

```
~/.backup-tool/
├── backup.config.json5    # Default config / 默认配置文件
├── logs/                  # Log directory / 日志目录
│   └── backup.log
└── backups/               # Backup output / 备份输出目录
    ├── data/              # Incremental task output / 增量备份任务输出
    └── nginx/             # Full task output / 全量备份任务输出
        ├── nginx_20260811-030000.zip
        ├── nginx_20260818-030000.zip
        └── ...
```

---

## Full Config Example / 完整配置示例

```json5
{
  // ============ Global log config / 全局日志配置 ============
  log: {
    // Log level: debug | info | warn | error, default info / 日志级别，默认 info
    level: "info",
    // Log directory, default ~/.backup-tool/logs / 日志目录，默认 ~/.backup-tool/logs
    dir: "~/.backup-tool/logs",
    // Number of log files to keep, default 30 / 日志文件保留数量，默认 30
    maxFiles: 30,
    // Max size of a single log file, default 10m / 单个日志文件大小，默认 10m
    maxSize: "10m",
  },

  // ============ Server list (each contains its own tasks) / 服务器列表 ============
  servers: [
    {
      // ---- Connection info / 连接信息 ----
      host: "192.168.1.100",        // Required / 必填: SFTP server address / SFTP 服务器地址
      port: 22,                     // Optional, default 22 / 可选，默认 22
      username: "root",             // Required / 必填: username / 用户名

      // ---- Auth (auto-detected, pick one) / 认证（自动判断，二选一即可） ----
      password: "your-password",    // If present → password auth / 有此项 → 密码认证
      // privateKeyPath: "~/.ssh/id_rsa", // If present → private key auth / 有此项 → 私钥认证
      // passphrase: "xxx",         // Private key passphrase (optional) / 私钥口令（可选）

      // ---- Connection & retry (optional, defaults used if omitted) / 连接与重试（可选） ----
      // connectTimeout: 10000,     // Default 10000ms / 默认 10000ms
      // retry: { max: 3, delay: 5000 }, // Default / 默认 { max: 3, delay: 5000 }

      // ---- Tasks for this server (multiple allowed) / 该服务器下的备份任务 ----
      tasks: [
        // ---------- Incremental backup / 增量备份 ----------
        {
          name: "data",                  // Required / 必填: task name / 任务名称
          enabled: true,                 // Optional, default true / 可选，是否启用，默认 true
          type: "incremental",           // Required / 必填: incremental | full
          cron: "0 2 * * *",             // Required / 必填: cron expression / cron 表达式
          source: "/data",               // Required / 必填: remote source path / 远程源路径
          destination: "~/.backup-tool/backups/data", // Required / 必填: local destination / 本地目标路径

          incremental: {
            // Compare by: name | size | mtime, default ["name","size","mtime"] / 比较依据，默认
            compareBy: ["name", "size", "mtime"],
            // Delete local files removed on remote, default false / 远程删除的文件本地是否同步删除，默认 false
            deleteRemoved: false,
            // Include rules (priority over exclude), default [] / 仅包含规则（优先于 exclude），默认 []
            include: ["**/*.sql"],
            // Exclude rules, default [] / 排除规则，默认 []
            exclude: ["*.tmp", "*.log"],
            // Concurrent downloads, default 4 / 并发下载数，默认 4
            concurrency: 4,
          },
        },

        // ---------- Full backup / 全量备份 ----------
        {
          name: "nginx",
          enabled: true,
          type: "full",
          cron: "0 3 * * 0",
          source: "/etc/nginx",
          destination: "~/.backup-tool/backups/nginx",

          full: {
            // Max backups to keep, delete oldest beyond this, default 5 / 最多保留份数，默认 5
            maxBackups: 5,
            // Timestamp suffix format, default YYYYMMDD-HHmmss / 时间戳后缀格式，默认
            timestampFormat: "YYYYMMDD-HHmmss",
            // Compress to zip, default true / 是否压缩为 zip，默认 true
            compress: true,
            // Exclude rules, default [] / 排除规则，默认 []
            exclude: ["*.log"],
          },
        },
      ],
    },

    // Second server (private key auth) / 第二个服务器（私钥认证）
    {
      host: "192.168.1.101",
      username: "backup",
      privateKeyPath: "~/.ssh/id_rsa",
      passphrase: "my-passphrase",
      tasks: [
        {
          name: "app",
          type: "incremental",
          cron: "*/30 * * * *",  // Every 30 minutes / 每 30 分钟
          source: "/var/log/app",
          destination: "~/.backup-tool/backups/app",
        },
      ],
    },
  ],
}
```

---

## Development / 开发

```bash
# Clone the repo / 克隆仓库
git clone https://github.com/qq306863030/backup-tool.git
cd backup-tool

# Install dependencies / 安装依赖
npm install

# Run unit tests / 运行单元测试
npm test

# Run directly (dev mode) / 直接运行（开发模式）
npm start
```

---

## License / 许可证

[MIT](LICENSE)
