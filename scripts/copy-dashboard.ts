import { cp } from "node:fs/promises";

await cp("src/dashboard/public", "dist/dashboard/public", { recursive: true });
