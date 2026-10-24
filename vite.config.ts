import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      tslint: {
        command: "bun ../../scripts/type-check.ts",
        cache: false,
      },
    },
  },
});
