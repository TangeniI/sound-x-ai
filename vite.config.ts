import { defineConfig } from "vite";
import react            from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  // Proxy /api/* to Vercel dev server in local development
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target:       "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },

  optimizeDeps: {
    // Magenta ships CommonJS bundles — force Vite to pre-bundle it
    include: ["@magenta/music", "tone", "@tonejs/midi"],
  },

  build: {
    target:    "esnext",
    // Magenta + TF.js are large; increase the chunk warning threshold
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks: {
          magenta:    ["@magenta/music"],
          tone:       ["tone"],
          react:      ["react", "react-dom"],
          framer:     ["framer-motion"],
        },
      },
    },
  },
});
