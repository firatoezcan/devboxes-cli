import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      tslint: {
        command: "bun check --project tsconfig.json",
        cache: false,
      },
    },
  },
});
