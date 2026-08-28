import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

let packed = (await readFile("scripts/packed-source.js.gz.b64", "utf8")).replace(/\s+/g, "");
// One character was corrupted during the GitHub upload of the packed payload.
packed = packed.replace("BwVd+9KT3J5ox54EiHwi", "BwVd+9KT3J7ox54EiHwi");
const raw = gunzipSync(Buffer.from(packed, "base64"));
if (!raw.includes("getImageData") || !raw.includes("CARD_VERSION = \"1.0.4\"")) {
  throw new Error("Restored source is missing the 1.0.4 ImageData fix");
}
await writeFile("src/flight-orbit-3d-card.js", raw);
console.log(`Restored src/flight-orbit-3d-card.js (${raw.length} bytes)`);
