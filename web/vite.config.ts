import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // `npm run start:static` собирает приложение с относительными URL, чтобы dist/index.html можно было открыть напрямую.
  base: process.env.VITE_FILE_BUILD === "1" ? "./" : "/",
  plugins: [react()],
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
})
