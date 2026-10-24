import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      tslint: {
        command: "tsc --noEmit --project tsconfig.json",
        cache: false,
      },
    },
  },
});
