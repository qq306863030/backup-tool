# lite-backup-tool

> A lightweight SFTP backup tool supporting incremental and full backups.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)

**English** | [中文](README.md)

---

## Features

- 🔄 **Incremental backup**: Only downloads changed files by comparing name, size, and modification time.
- 📦 **Full backup**: Creates timestamped snapshots and auto-cleans old versions (by `maxBackups`).
- 🔐 **SFTP support**: Supports password and private key authentication (auto-detected).
- ⏰ **Cron scheduling**: Uses standard cron expressions for flexible scheduling.
- 🛡️ **PM2 daemon**: Process guard, auto-restart, and memory monitoring.
- 📝 **JSON5 config**: Supports comments, trailing commas, and single quotes.
- 🗜️ **ZIP compression**: Full backups are auto-compressed to zip.
- 🎯 **Filter rules**: Incremental backup supports `include`/`exclude` glob filters (include takes priority).
- ⏸️ **Resumable transfer**: `backup up` / `backup down` resume automatically from where they left off after an interruption.
- 📊 **Live progress**: Upload/download progress is shown in place on a single console line (no scrolling).
- 🔀 **Command alias**: `bak` is fully equivalent to `backup`.

---

## Quick Start

### 1. Install

**Prerequisite: this tool runs as a PM2 daemon, so please install PM2 globally first:**

```bash
npm install -g pm2
```

Then install `lite-backup-tool` globally:

```bash
npm install lite-backup-tool -g -verbose
```

> Requires **Node.js >= 18**.
>
> Note: PM2 **must be installed globally**. Installing it locally via `npm install pm2` will cause `backup start` to fail with "未检测到 PM2" / "PM2 not detected" error.

### 2. Create config file

Create a config file at `~/.backup-tool/backup.config.json5` (the directory is auto-created on first `backup start`):

```json5
{
  servers: [
    {
      name: "prod",               // Optional: server name (used by backup up/down), defaults to host
      host: "192.168.1.100",
      username: "root",
      password: "your-password",

      tasks: [
        // Incremental backup: sync files at 2 AM daily
        {
          name: "data",
          type: "incremental",
          cron: "0 2 * * *",
          source: "/data",
          destination: "~/.backup-tool/backups/data",
        },
        // Full backup: full backup at 3 AM every Sunday
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

### 3. Start the service

```bash
# Use default config ~/.backup-tool/backup.config.json5
backup start

# Specify a config file
backup start /path/to/your-config.json5
backup start my-config.json5  # searched in ~/.backup-tool
```

> **Alias**: `bak` is an alias for `backup` (available after global npm install). Every command works with `bak` too, e.g. `bak exec`, `bak up prod ./file`.

---

## Commands

| Command | Description |
|------|------|
| `backup start [configFilePath]` | Start backup service (PM2 daemon) |
| `backup exec [configFilePath]` | Run all enabled tasks immediately (skip scheduling) |
| `backup up <server-name> <file/folder> [remote-path]` | Upload a local file/folder to the server (relative paths are based on `upload-basedir`) |
| `backup down <server-name> <file/folder> [local-path]` | Download a file/folder from the server (relative paths are based on `upload-basedir`) |
| `backup stop` | Stop backup service |
| `backup clear` | Clear PM2 instance |
| `backup reload [configFilePath]` | Reload config and restart |
| `backup logs` | View service logs |
| `backup help` | Show help |

### Upload / Download examples

`server-name` maps to the server's `name` field; when unset it defaults to `host`.

Remote path resolution rules (`upload-basedir` is the optional base directory configured on the server):

- **Absolute paths** (starting with `/`): used as-is, bypass the base directory.
- **Relative paths**: resolved against `upload-basedir`.
- **No remote path given** (upload only): defaults to `upload-basedir`; if unset, defaults to the server home directory.

```bash
# Upload a local file (to the home directory if no base dir, or to the base dir if configured)
backup up prod ./nginx.conf

# Upload a local folder to an absolute remote path
backup up prod ./configs /etc/app

# Upload a local folder to a relative path under the base dir
backup up prod ./configs app/configs

# Download a remote file (absolute path)
backup down prod /etc/nginx/nginx.conf

# Download a relative path under the base dir
backup down prod conf.d/nginx.conf

# Download a remote folder to a local directory
backup down prod /etc/nginx ./downloads
```

> Transfers support **resumable upload/download** and show **live progress** on a single console line.

### Cron expression

The `cron` field of each task uses a standard **5-field cron expression**:

```
minute hour day month weekday
```

| Field | Range | Description |
|-------|-------|-------------|
| minute | `0-59` | Minute |
| hour | `0-23` | Hour |
| day | `1-31` | Day of month |
| month | `1-12` | Month |
| weekday | `0-7` | Day of week (`0` and `7` both mean Sunday) |

**Special characters:**

| Char | Meaning | Example |
|------|---------|---------|
| `*` | Any value | `* * * * *` every minute |
| `,` | List | `0,30 * * * *` at minute 0 and 30 of every hour |
| `-` | Range | `0 9-18 * * *` every hour from 9 AM to 6 PM |
| `/` | Step | `*/5 * * * *` every 5 minutes |

**Common examples:**

| cron expression | Meaning |
|-----------------|---------|
| `0 2 * * *` | Every day at 2 AM |
| `0 3 * * 0` | Every Sunday at 3 AM |
| `*/30 * * * *` | Every 30 minutes |
| `0 0 1 * *` | At midnight on the 1st of every month |
| `0 9-18 * * 1-5` | Every hour from 9 AM to 6 PM on weekdays (Mon-Fri) |

### Config file path resolution

The `configFilePath` argument of `backup start` / `backup reload` supports:

1. **Absolute path**: `backup start /etc/backup/my-config.json5`
2. **Relative path**: `backup start ./configs/backup.json5`
3. **File name**: `backup start my-config.json5` (searched in `~/.backup-tool/`)
4. **No argument**: uses default `~/.backup-tool/backup.config.json5`

If the config file does not exist, an error is reported and the process exits.

### Directory structure

```
~/.backup-tool/
├── backup.config.json5    # Default config
├── logs/                  # Log directory
│   └── backup.log
└── backups/               # Backup output
    ├── data/              # Incremental task output
    └── nginx/             # Full task output
        ├── nginx_20260811-030000.zip
        ├── nginx_20260818-030000.zip
        └── ...
```

---

## Full Config Example

```json5
{
  // ============ Global log config ============
  log: {
    // Log level: debug | info | warn | error, default info
    level: "info",
    // Log directory, default ~/.backup-tool/logs
    dir: "~/.backup-tool/logs",
    // Number of log files to keep, default 30
    maxFiles: 30,
    // Max size of a single log file, default 10m
    maxSize: "10m",
  },

  // ============ Server list (each contains its own tasks) ============
  servers: [
    {
      // ---- Connection info ----
      name: "prod",                 // Optional: server name (used by backup up/down), defaults to host
      host: "192.168.1.100",        // Required: SFTP server address
      port: 22,                     // Optional, default 22
      username: "root",             // Required: username

      // ---- Upload/download base directory (optional) ----
      // Relative paths of backup up/down are resolved against it; if unset, they are
      // resolved against the server home directory
      // upload-basedir: "/srv/backup",

      // ---- Auth (auto-detected, pick one) ----
      password: "your-password",    // If present → password auth
      // privateKeyPath: "~/.ssh/id_rsa", // If present → private key auth
      // passphrase: "xxx",         // Private key passphrase (optional)

      // ---- Connection & retry (optional, defaults used if omitted) ----
      // connectTimeout: 10000,     // Default 10000ms
      // retry: { max: 3, delay: 5000 }, // Default { max: 3, delay: 5000 }

      // ---- Tasks for this server (multiple allowed) ----
      tasks: [
        // ---------- Incremental backup ----------
        {
          name: "data",                  // Required: task name
          enabled: true,                 // Optional, default true
          type: "incremental",           // Required: incremental | full
          cron: "0 2 * * *",             // Required: cron expression
          source: "/data",               // Required: remote source path
          destination: "~/.backup-tool/backups/data", // Required: local destination

          incremental: {
            // Compare by: name | size | mtime, default ["name","size","mtime"]
            compareBy: ["name", "size", "mtime"],
            // Delete local files removed on remote, default false
            deleteRemoved: false,
            // Include rules (priority over exclude), default []
            include: ["**/*.sql"],
            // Exclude rules, default []
            exclude: ["*.tmp", "*.log"],
            // Concurrent downloads, default 4
            concurrency: 4,
          },
        },

        // ---------- Full backup ----------
        {
          name: "nginx",
          enabled: true,
          type: "full",
          cron: "0 3 * * 0",
          source: "/etc/nginx",
          destination: "~/.backup-tool/backups/nginx",

          full: {
            // Max backups to keep, delete oldest beyond this, default 5
            maxBackups: 5,
            // Timestamp suffix format, default YYYYMMDD-HHmmss
            timestampFormat: "YYYYMMDD-HHmmss",
            // Compress to zip, default true
            compress: true,
            // Exclude rules, default []
            exclude: ["*.log"],
          },
        },
      ],
    },

    // Second server (private key auth)
    {
      host: "192.168.1.101",
      username: "backup",
      privateKeyPath: "~/.ssh/id_rsa",
      passphrase: "my-passphrase",
      tasks: [
        {
          name: "app",
          type: "incremental",
          cron: "*/30 * * * *",  // Every 30 minutes
          source: "/var/log/app",
          destination: "~/.backup-tool/backups/app",
        },
      ],
    },
  ],
}
```

---

## Development

```bash
# Clone the repo
git clone https://github.com/qq306863030/backup-tool.git
cd backup-tool

# Install dependencies
npm install

# Run unit tests
npm test

# Run directly (dev mode)
npm start
```

---

## License

[MIT](LICENSE)
