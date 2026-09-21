import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // The mascot pulls in ajv for definition validation. Splitting it out
        // keeps the form and the report interactive without waiting on it.
        manualChunks: {
          avatar: ["@bible-strong/avatar-react", "@bible-strong/avatar-core"],
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
