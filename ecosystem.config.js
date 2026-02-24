module.exports = {
  apps: [{
    name: 'jin',
    script: 'agent.js',
    kill_timeout: 10000,         // 10s — give app.stop() time to send WebSocket close frame
    wait_ready: false,
    max_restarts: 10,
    min_uptime: 10000,
    restart_delay: 3000,         // 3s delay between restarts — let Slack detect disconnects
    max_memory_restart: '512M',
  }]
};
