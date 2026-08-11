# lite-backup-tool

> 一个轻量级的 SFTP 备份工具，支持增量备份与全量备份。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)

[English](README.en.md) | **中文**

---

## 功能特性

- 🔄 **增量备份**：通过文件名称、大小、修改时间智能判断，只下载有差异的文件
- 📦 **全量备份**：每次生成带时间戳的独立副本，支持自动清理旧版本（按 `maxBackups` 保留）
- 🔐 **SFTP 支持**：支持密码认证和私钥认证（自动判断）
- ⏰ **Cron 调度**：使用标准 cron 表达式灵活设置任务执行时间
- 🛡️ **PM2 常驻**：进程守护、崩溃自动重启、内存监控
- 📝 **JSON5 配置**：支持注释、尾逗号、单引号，运维友好
- 🗜️ **ZIP 压缩**：全量备份自动压缩为 zip，节省存储空间
- 🎯 **过滤规则**：增量备份支持 `include`/`exclude` glob 过滤（include 优先）

---

## 快速开始

### 1. 安装

全局安装 `lite-backup-tool`（PM2 已作为依赖自动安装，无需额外配置）：

```bash
npm install lite-backup-tool -g -verbose
```

> 要求 **Node.js >= 18**。

### 2. 创建配置文件

在 `~/.backup-tool/backup.config.json5` 创建配置文件（首次运行 `backup start` 会自动创建该目录）：

```json5
{
  servers: [
    {
      host: "192.168.1.100",
      username: "root",
      password: "your-password",

      tasks: [
        // 增量备份：每天凌晨 2 点同步文件
        {
          name: "data",
          type: "incremental",
          cron: "0 2 * * *",
          source: "/data",
          destination: "~/.backup-tool/backups/data",
        },
        // 全量备份：每周日凌晨 3 点全量备份目录
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

### 3. 启动服务

```bash
# 使用默认配置文件 ~/.backup-tool/backup.config.json5
backup start

# 指定配置文件
backup start /path/to/your-config.json5
backup start my-config.json5  # 在 ~/.backup-tool 下查找
```

---

## 命令说明

| 命令 | 说明 |
|------|------|
| `backup start [configFilePath]` | 启动备份服务（通过 PM2 常驻运行） |
| `backup stop` | 停止备份服务 |
| `backup clear` | 清除 PM2 中的实例 |
| `backup reload [configFilePath]` | 重载配置并重启服务 |
| `backup logs` | 查看服务日志 |
| `backup help` | 显示帮助信息 |

### Cron 表达式说明

每个任务的 `cron` 字段使用标准 **5 段 cron 表达式**，格式为：

```
分 时 日 月 周
```

| 字段 | 取值范围 | 说明 |
|------|----------|------|
| 分 | `0-59` | 分钟 |
| 时 | `0-23` | 小时 |
| 日 | `1-31` | 日期 |
| 月 | `1-12` | 月份 |
| 周 | `0-7` | 星期（`0` 和 `7` 都表示周日） |

**特殊字符：**

| 字符 | 含义 | 示例 |
|------|------|------|
| `*` | 任意值 | `* * * * *` 每分钟 |
| `,` | 列表 | `0,30 * * * *` 每小时的 0 分和 30 分 |
| `-` | 范围 | `0 9-18 * * *` 每天 9 点到 18 点每小时 |
| `/` | 步长 | `*/5 * * * *` 每 5 分钟 |

**常用示例：**

| cron 表达式 | 含义 |
|-------------|------|
| `0 2 * * *` | 每天凌晨 2 点 |
| `0 3 * * 0` | 每周日凌晨 3 点 |
| `*/30 * * * *` | 每 30 分钟 |
| `0 0 1 * *` | 每月 1 号零点 |
| `0 9-18 * * 1-5` | 工作日（周一至周五）9 点到 18 点每小时 |

### 配置文件路径解析规则

`backup start` / `backup reload` 命令的 `configFilePath` 参数支持以下形式：

1. **绝对路径**：`backup start /etc/backup/my-config.json5`
2. **相对路径**：`backup start ./configs/backup.json5`
3. **文件名**：`backup start my-config.json5`（在 `~/.backup-tool/` 下查找）
4. **不传参数**：使用默认路径 `~/.backup-tool/backup.config.json5`

如果配置文件不存在，会报错并退出。

### 目录结构

```
~/.backup-tool/
├── backup.config.json5    # 默认配置文件
├── logs/                  # 日志目录
│   └── backup.log
└── backups/               # 备份输出目录
    ├── data/              # 增量备份任务输出
    └── nginx/             # 全量备份任务输出
        ├── nginx_20260811-030000.zip
        ├── nginx_20260818-030000.zip
        └── ...
```

---

## 完整配置示例

```json5
{
  // ============ 全局日志配置 ============
  log: {
    // 日志级别：debug | info | warn | error，默认 info
    level: "info",
    // 日志目录，默认 ~/.backup-tool/logs
    dir: "~/.backup-tool/logs",
    // 日志文件保留数量，默认 30
    maxFiles: 30,
    // 单个日志文件大小，默认 10m
    maxSize: "10m",
  },

  // ============ 服务器列表（每个内含自己的 tasks） ============
  servers: [
    {
      // ---- 连接信息 ----
      host: "192.168.1.100",        // 必填：SFTP 服务器地址
      port: 22,                     // 可选，默认 22
      username: "root",             // 必填：用户名

      // ---- 认证（自动判断，二选一即可） ----
      password: "your-password",    // 有此项 → 密码认证
      // privateKeyPath: "~/.ssh/id_rsa", // 有此项 → 私钥认证
      // passphrase: "xxx",         // 私钥口令（可选，仅私钥认证时用）

      // ---- 连接与重试（可选，省略用默认值） ----
      // connectTimeout: 10000,     // 默认 10000ms
      // retry: { max: 3, delay: 5000 }, // 默认 { max: 3, delay: 5000 }

      // ---- 该服务器下的备份任务（可多个） ----
      tasks: [
        // ---------- 增量备份 ----------
        {
          name: "data",                  // 必填：任务名称（用于日志与全量备份目录名）
          enabled: true,                 // 可选，是否启用，默认 true
          type: "incremental",           // 必填：incremental | full
          cron: "0 2 * * *",             // 必填：cron 表达式（分 时 日 月 周）
          source: "/data",               // 必填：远程源路径（文件或目录）
          destination: "~/.backup-tool/backups/data", // 必填：本地目标路径

          incremental: {
            // 比较依据：name | size | mtime，默认 ["name","size","mtime"]
            compareBy: ["name", "size", "mtime"],
            // 远程删除的文件本地是否同步删除，默认 false
            deleteRemoved: false,
            // 仅包含规则（优先于 exclude），默认 []
            include: ["**/*.sql"],
            // 排除规则，默认 []
            exclude: ["*.tmp", "*.log"],
            // 并发下载数，默认 4
            concurrency: 4,
          },
        },

        // ---------- 全量备份 ----------
        {
          name: "nginx",
          enabled: true,
          type: "full",
          cron: "0 3 * * 0",
          source: "/etc/nginx",
          destination: "~/.backup-tool/backups/nginx",

          full: {
            // 最多保留份数，超出删除最老的，默认 5
            maxBackups: 5,
            // 时间戳后缀格式，默认 YYYYMMDD-HHmmss
            timestampFormat: "YYYYMMDD-HHmmss",
            // 是否压缩为 zip，默认 true
            compress: true,
            // 排除规则，默认 []
            exclude: ["*.log"],
          },
        },
      ],
    },

    // 第二个服务器（私钥认证）
    {
      host: "192.168.1.101",
      username: "backup",
      privateKeyPath: "~/.ssh/id_rsa",
      passphrase: "my-passphrase",
      tasks: [
        {
          name: "app",
          type: "incremental",
          cron: "*/30 * * * *",  // 每 30 分钟
          source: "/var/log/app",
          destination: "~/.backup-tool/backups/app",
        },
      ],
    },
  ],
}
```

---

## 开发

```bash
# 克隆仓库
git clone https://github.com/qq306863030/backup-tool.git
cd backup-tool

# 安装依赖
npm install

# 运行单元测试
npm test

# 直接运行（开发模式）
npm start
```

---

## 许可证

[MIT](LICENSE)
