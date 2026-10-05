import { readFile, writeFile } from "node:fs/promises";

const [file] = process.argv.slice(2);
if (!file) throw new Error("PE file path is required");
const data = await readFile(file);
if (data.length < 0x40 || data.toString("ascii", 0, 2) !== "MZ") throw new Error("Not a PE executable");
const peOffset = data.readUInt32LE(0x3c);
if (peOffset + 12 > data.length || data.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
  throw new Error("Invalid PE header");
}
// COFF TimeDateStamp is the only nondeterministic field emitted by MinGW/LLD.
data.writeUInt32LE(0, peOffset + 8);
await writeFile(file, data);
