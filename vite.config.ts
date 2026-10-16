import { defineConfig } from "vite";
export default defineConfig({
  root: "src/dashboard/web",
  build: {
    outDir: "../public",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        assetFileNames: "assets/app.[ext]",
      },
    },
  },
});
