import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { gzipSync } from "node:zlib";

const maplibreCssPath = "node_modules/maplibre-gl/dist/maplibre-gl.css";
const maplibreWorkerPath = "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs";
const cardSourcePath = "src/flight-orbit-3d-card.js";
const outputPath = "dist/flight-orbit-3d-card.js";

const [maplibreCss, cardSource] = await Promise.all([
  readFile(maplibreCssPath, "utf8"),
  readFile(cardSourcePath, "utf8"),
]);

const workerBuild = await build({
  entryPoints: [maplibreWorkerPath],
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2022",
  write: false,
});
const workerCode = workerBuild.outputFiles[0].text;
const compressedWorker = gzipSync(workerCode, { level: 9 }).toString("base64");

const maplibreBuild = await build({
  stdin: {
    contents: `
      import { Map, NavigationControl, LngLatBounds, setWorkerUrl } from "maplibre-gl";
      const maplibregl = { Map, NavigationControl, LngLatBounds };
      globalThis.maplibregl = maplibregl;
      globalThis.maplibreglReady = (async () => {
        if (!globalThis.DecompressionStream) throw new Error("This browser is too old for the bundled map engine.");
        const compressed = Uint8Array.from(atob(${JSON.stringify(compressedWorker)}), character => character.charCodeAt(0));
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
        const workerCode = await new Response(stream).text();
        const workerUrl = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
        setWorkerUrl(workerUrl);
        return maplibregl;
      })();
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2022",
  write: false,
  logLevel: "warning",
});
const maplibreJs = maplibreBuild.outputFiles[0].text;

const marker = JSON.stringify("__MAPLIBRE_CSS__");
if (!cardSource.includes(marker)) throw new Error("MapLibre CSS marker is missing from the card source.");

const bundledCard = cardSource.replace(marker, JSON.stringify(maplibreCss));
const output = `/* MapLibre GL JS 6.6.0 — BSD-3-Clause */\n${maplibreJs}\n\n${bundledCard}`;

await mkdir("dist", { recursive: true });
await writeFile(outputPath, output, "utf8");
console.log(`Built ${outputPath} (${Buffer.byteLength(output).toLocaleString()} bytes)`);
console.log(`MapLibre main: ${Buffer.byteLength(maplibreJs).toLocaleString()} bytes; worker gzip/base64: ${Buffer.byteLength(compressedWorker).toLocaleString()} bytes`);
