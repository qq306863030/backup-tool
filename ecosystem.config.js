module.exports = {
  apps: [
    {
      name: "backup-tool",
      script: "src/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "300M",
      cron_restart: "0 4 * * *",
      env: {
        NODE_ENV: "production",
        BACKUP_CONFIG: "./config/backup.config.json5",
      },
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
