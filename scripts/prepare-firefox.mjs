import { copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const outputDir = join(root, "dist", "firefox");
const files = [
  "background.js",
  "content.css",
  "content.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "README.md",
  "LICENSE"
];

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

await copyFile(join(root, "manifest.firefox.json"), join(outputDir, "manifest.json"));
await Promise.all(files.map((file) => copyFile(join(root, file), join(outputDir, file))));

console.log(`Firefox extension prepared at ${outputDir}`);
