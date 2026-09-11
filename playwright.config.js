import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests/browser',use:{baseURL:'http://127.0.0.1:8766'},
  webServer:{command:'node scripts/serve.mjs',url:'http://127.0.0.1:8766',reuseExistingServer:true}});
