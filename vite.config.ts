import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "dashboard",
  plugins: [react()],
  server: {
    host: process.env.HOST ?? "::",
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://127.0.0.1:3001",
        changeOrigin: true,
        ws: true
      }
    }
  },
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true
  }
});
