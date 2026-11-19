import {defineConfig} from 'vite';
export default defineConfig({server:{proxy:{'/api':{target:process.env.DOCKER_API_URL||'http://localhost:8000',changeOrigin:true}}}})
