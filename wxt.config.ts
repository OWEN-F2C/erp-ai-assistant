import { defineConfig } from 'wxt';

export default defineConfig({
  outDir: 'dist',
  manifest: {
    name: 'ERP增强助手',
    version: '1.5.6',
    permissions: ['storage', 'cookies', 'unlimitedStorage', 'alarms'],
    web_accessible_resources: [{
      resources: ['floating-ball.png'],
      matches: ['*://*.app.gerpgo.com/*', '*://*.jijia.com.cn/*'],
    }],
    host_permissions: [
      '*://*.jijia.com.cn/*',
      '*://*.app.gerpgo.com/*',
      '*://gateway.apist.gerpgo.com/*',
      '*://api.deepseek.com/*',
    ],
    action: {
      default_icon: {
        '16': '/icons/icon-blue-16.png',
        '32': '/icons/icon-blue-32.png',
      },
      default_title: 'ERP增强助手',
    },
  },
});
