import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@":           path.resolve(__dirname, "./src"),
      "@ui":         path.resolve(__dirname, "./src/ui"),
      "@shell":      path.resolve(__dirname, "./src/shell"),
      "@editor":     path.resolve(__dirname, "./src/editor"),
      "@store":      path.resolve(__dirname, "./src/store"),
      "@bridge":     path.resolve(__dirname, "./src/bridge"),
      "@theme":      path.resolve(__dirname, "./src/theme"),
      "@motion":     path.resolve(__dirname, "./src/motion"),
      "@ir":         path.resolve(__dirname, "./src/ir"),
      "@lib":        path.resolve(__dirname, "./src/lib"),
      "@commands":   path.resolve(__dirname, "./src/commands"),
      "@version":    path.resolve(__dirname, "./src/version"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2022",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  // Vitest — inlined so `vite` and `vitest` share one config
  // https://vitest.dev/config/
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "dist", "src-tauri/target"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      exclude: ["node_modules", "dist", "src-tauri"],
    },
  } as any,
});
