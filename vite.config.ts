import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      tslint: {
        command: "bun run --bun tsc --noEmit --project tsconfig.json",
        cache: false,
      },
    },
  },
});
