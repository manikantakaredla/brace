import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || process.env.DOCKER_API_URL || 'https://brace-api-y8ha.onrender.com',
        changeOrigin: true,
      },
    },
  },
});
