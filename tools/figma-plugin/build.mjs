import { cp, mkdir } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await cp("src/ui.html", "dist/ui.html");
