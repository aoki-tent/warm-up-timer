import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,           // LAN 公開 (同じ Wi-Fi の iPhone から見られるように)
    port: 5176,
    strictPort: true,     // 5176 が埋まってたらエラーにする (静かに別ポートに逃がさない)
  },
})
