import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  server: { port: 5173 },

  optimizeDeps: {
    // Magenta ships CommonJS bundles — force Vite to pre-bundle it.
    // It's only loaded lazily (deep mode), but pre-bundling avoids dev errors.
    include: ["@magenta/music", "tone", "@tonejs/midi"],
  },

  build: {
    target: "esnext",
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks: {
          magenta: ["@magenta/music"],
          tone: ["tone"],
          react: ["react", "react-dom"],
          framer: ["framer-motion"],
        },
      },
    },
  },
});
