import { readFile, writeFile } from "node:fs/promises";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: node scripts/prepare-portable-html.mjs <input> <output>");
  process.exit(1);
}

let html = await readFile(input, "utf8");

// The regular web build may use Google Fonts when online. The portable build
// removes every remote font request so startup is fully offline and immediate;
// Windows falls back to Segoe UI and its built-in monospace font.
html = html
  .replace(/\s*<link[^>]+href=["']https:\/\/fonts\.googleapis\.com[^>]*>\s*/gi, "\n")
  .replace(/\s*<link[^>]+href=["']https:\/\/fonts\.gstatic\.com[^>]*>\s*/gi, "\n")
  .replace(/\s*<link[^>]+rel=["']preconnect["'][^>]+fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/gi, "\n");

await writeFile(output, html, "utf8");
