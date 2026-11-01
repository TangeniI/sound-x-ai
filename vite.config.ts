import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  server: { port: 5173 },

  optimizeDeps: {
    include: ["@tonejs/midi"],
  },

  build: {
    target: "es2020",
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          framer: ["framer-motion"],
        },
      },
    },
  },
});
