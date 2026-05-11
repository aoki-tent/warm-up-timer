import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

function gitShortSha() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim()
  } catch {
    return 'nogit'
  }
}

function buildStamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    __BUILD_VERSION__: JSON.stringify(
      command === 'serve' ? `dev ${buildStamp()}` : `${gitShortSha()} · ${buildStamp()}`
    ),
  },
  server: {
    host: true,           // LAN 公開 (同じ Wi-Fi の iPhone から見られるように)
    port: 5176,
    strictPort: true,     // 5176 が埋まってたらエラーにする (静かに別ポートに逃がさない)
  },
}))
