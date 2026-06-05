import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  server: { port: 5173 },

  optimizeDeps: {
    include: ["tone", "@tonejs/midi"],
  },

  build: {
    target: "esnext",
    rollupOptions: {
      output: {
        manualChunks: {
          tone: ["tone"],
          react: ["react", "react-dom"],
          framer: ["framer-motion"],
        },
      },
    },
  },
});
