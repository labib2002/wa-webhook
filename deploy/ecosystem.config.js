// PM2 config for byteplus-prod-app. Copy to /opt/wa-webhook/ecosystem.config.js.
//
// fork mode with instances:1 is NOT a default, it is required:
//   - cluster mode would double-fire anything scheduled, and
//   - lib/loginLimiter.js keeps its fallback state in a per-process Map, so N
//     processes means N times the login failure budget.
// The backend's own `server` runs cluster x2 and gates schedules on pm_id == 0;
// wa-webhook has no such gate.

module.exports = {
  apps: [{
    name: 'wa-webhook',
    script: 'app.js',
    cwd: '/opt/wa-webhook',
    exec_mode: 'fork',
    instances: 1,
    env: {
      // Vercel injected NODE_ENV; PM2 does not. lib/auth.js gates the Secure
      // cookie flag on it, so without this the session cookie loses Secure.
      NODE_ENV: 'production',
      // 8000, 3333, 8888 and 5601 are taken on this box.
      PORT: 8080,
      // Makes lib/boot.js refuse to start if NODE_ENV ever drifts.
      WA_DEPLOY_ENV: 'prod',
      TZ: 'UTC',
    },
    max_memory_restart: '512M',
    // PM2's default 1600ms SIGKILLs a mid-flight media download. app.js drains
    // on SIGTERM within 55s, so this must stay above that.
    kill_timeout: 60000,
    exp_backoff_restart_delay: 200,
    max_restarts: 10,
    time: true,
    autorestart: true,
  }],
};
