const path = require('path');
const os = require('os');

const HOME_DIR = path.join(os.homedir(), '.backup-tool');
const LOG_DIR = path.join(HOME_DIR, 'logs');

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
      },
      out_file: path.join(LOG_DIR, "pm2-out.log"),
      error_file: path.join(LOG_DIR, "pm2-error.log"),
      merge_logs: true,
      time: true,
    },
  ],
};
