import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const maplibreJsPath = "node_modules/maplibre-gl/dist/maplibre-gl.js";
const maplibreCssPath = "node_modules/maplibre-gl/dist/maplibre-gl.css";
const cardSourcePath = "src/flight-orbit-3d-card.js";
const outputPath = "dist/flight-orbit-3d-card.js";

const [maplibreJs, maplibreCss, cardSource] = await Promise.all([
  readFile(maplibreJsPath, "utf8"),
  readFile(maplibreCssPath, "utf8"),
  readFile(cardSourcePath, "utf8"),
]);

const marker = JSON.stringify("__MAPLIBRE_CSS__");
if (!cardSource.includes(marker)) throw new Error("MapLibre CSS marker is missing from the card source.");

const bundledCard = cardSource.replace(marker, JSON.stringify(maplibreCss));
const cardBuild = await build({
  stdin: { contents: bundledCard },
  minify: true,
  target: "es2022",
  write: false,
});
const minifiedCard = cardBuild.outputFiles[0].text;
const output = `/* MapLibre GL JS 5.6.0 — BSD-3-Clause */\n${maplibreJs}\n\n${minifiedCard}`;

await mkdir("dist", { recursive: true });
await writeFile(outputPath, output, "utf8");
console.log(`Built ${outputPath} (${Buffer.byteLength(output).toLocaleString()} bytes)`);
