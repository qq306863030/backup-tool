# backup-tool

> 从远程服务器（SFTP）自动拉取文件备份工具，支持**增量备份**与**全量备份**两种模式。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)

## 功能特性

- 🔄 **增量备份**：通过文件名称、大小、修改时间智能判断，只下载有差异的文件
- 📦 **全量备份**：每次生成带时间戳的独立副本，支持自动清理旧版本（按 `maxBackups` 保留）
- 🔐 **SFTP 支持**：支持密码认证和私钥认证（自动判断）
- ⏰ **Cron 调度**：使用标准 cron 表达式灵活设置任务执行时间
- 🛡️ **PM2 常驻**：进程守护、崩溃自动重启、内存监控
- 📝 **JSON5 配置**：支持注释、尾逗号、单引号，运维友好
- 🗜️ **ZIP 压缩**：全量备份自动压缩为 zip，节省存储空间
- 🎯 **过滤规则**：增量备份支持 `include`/`exclude` glob 过滤（include 优先）

## 快速开始

### 1. 安装

```bash
# 克隆仓库
git clone https://github.com/qq306863030/backup-tool.git
cd backup-tool

# 安装依赖
npm install

# 全局安装（可选，使 backup 命令全局可用）
npm link
```

### 2. 前置依赖

- **Node.js** >= 18
- **PM2**（用于进程守护）

```bash
npm install -g pm2
```

### 3. 创建配置文件

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

### 4. 启动服务

```bash
# 使用默认配置文件 ~/.backup-tool/backup.config.json5
backup start

# 指定配置文件
backup start /path/to/your-config.json5
backup start my-config.json5  # 在 ~/.backup-tool 下查找
```

## 命令说明

| 命令 | 说明 |
|------|------|
| `backup start [configFilePath]` | 启动备份服务（通过 PM2 常驻运行） |
| `backup stop` | 停止备份服务 |
| `backup clear` | 清除 PM2 中的实例 |
| `backup reload [configFilePath]` | 重载配置并重启服务 |
| `backup logs` | 查看服务日志 |
| `backup help` | 显示帮助信息 |

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

## 全量配置

### 顶层字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `log` | object | - | 见下 | 日志配置 |
| `servers` | array | ✅ | - | 服务器列表（每个内含自己的 tasks） |

### `log` 日志配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `level` | string | `"info"` | 日志级别：`debug`/`info`/`warn`/`error` |
| `dir` | string | `"~/.backup-tool/logs"` | 日志目录 |
| `maxFiles` | number | `30` | 日志文件保留数量 |
| `maxSize` | string | `"10m"` | 单个日志文件大小 |

### `servers[]` 服务器配置

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `host` | string | ✅ | - | SFTP 服务器地址 |
| `port` | number | - | `22` | 端口 |
| `username` | string | ✅ | - | 用户名 |
| `password` | string | 二选一 | - | 密码认证（有此项则用密码） |
| `privateKeyPath` | string | 二选一 | - | 私钥路径（有此项则用私钥） |
| `passphrase` | string | - | - | 私钥口令（仅私钥认证时） |
| `connectTimeout` | number | - | `10000` | 连接超时 ms |
| `retry.max` | number | - | `3` | 失败重试次数 |
| `retry.delay` | number | - | `5000` | 重试间隔 ms |
| `tasks` | array | ✅ | - | 该服务器下的备份任务 |

> **认证判断**：`password` 存在 → 密码认证；`privateKeyPath` 存在 → 私钥认证；两者都无 → 启动报错。

### `tasks[]` 任务配置

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `name` | string | ✅ | - | 任务名称（用于日志与全量备份目录名） |
| `enabled` | boolean | - | `true` | 是否启用 |
| `type` | string | ✅ | - | `incremental` / `full` |
| `cron` | string | ✅ | - | cron 表达式（分 时 日 月 周） |
| `source` | string | ✅ | - | 远程源路径（文件或目录） |
| `destination` | string | ✅ | - | 本地目标路径 |

### 增量任务 `incremental`（type=incremental 时）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `compareBy` | array | `["name","size","mtime"]` | 比较依据 |
| `deleteRemoved` | boolean | `false` | 远程删除的文件本地是否同步删除 |
| `include` | array | `[]` | 仅包含规则（**优先于 exclude**） |
| `exclude` | array | `[]` | 排除规则 |
| `concurrency` | number | `4` | 并发下载数 |

### 全量任务 `full`（type=full 时）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxBackups` | number | `5` | 最多保留份数，超出删除最老的 |
| `timestampFormat` | string | `"YYYYMMDD-HHmmss"` | 时间戳后缀格式 |
| `compress` | boolean | `true` | 是否压缩为 zip |
| `exclude` | array | `[]` | 排除规则 |

## 完整配置示例

```json5
{
  // 全局日志配置
  log: {
    level: "info",
    dir: "~/.backup-tool/logs",
    maxFiles: 30,
    maxSize: "10m",
  },

  servers: [
    {
      // SFTP 服务器连接信息
      host: "192.168.1.100",
      port: 22,
      username: "root",
      password: "your-password",

      // 连接与重试（可选，省略用默认值）
      // connectTimeout: 10000,
      // retry: { max: 3, delay: 5000 },

      tasks: [
        // 增量备份示例
        {
          name: "data",
          type: "incremental",
          cron: "0 2 * * *",
          source: "/data",
          destination: "~/.backup-tool/backups/data",
          incremental: {
            compareBy: ["name", "size", "mtime"],
            deleteRemoved: false,
            include: ["**/*.sql"],   // 仅备份 sql 文件
            exclude: ["*.tmp"],      // 排除临时文件
            concurrency: 4,
          },
        },

        // 全量备份示例
        {
          name: "nginx",
          type: "full",
          cron: "0 3 * * 0",
          source: "/etc/nginx",
          destination: "~/.backup-tool/backups/nginx",
          full: {
            maxBackups: 5,
            timestampFormat: "YYYYMMDD-HHmmss",
            compress: true,
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

## 打包

使用 Rollup 打包为单个可执行 bundle：

```bash
# 打包当前平台
npm run build

# 打包指定平台
npm run build:win
npm run build:linux
npm run build:mac
```

打包产物输出到 `dist/backup.js`，可通过 `node dist/backup.js <command>` 运行。

## 开发

```bash
# 运行单元测试
npm test

# 直接运行（开发模式）
npm start
```

## 许可证

[MIT](LICENSE)
