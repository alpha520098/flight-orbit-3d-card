import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const packed = (await readFile("scripts/packed-source.js.gz.b64", "utf8")).replace(/\s+/g, "");
const raw = gunzipSync(Buffer.from(packed, "base64"));
await writeFile("src/flight-orbit-3d-card.js", raw);
console.log(`Restored src/flight-orbit-3d-card.js (${raw.length} bytes)`);
