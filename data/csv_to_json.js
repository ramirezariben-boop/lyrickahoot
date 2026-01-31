import fs from "fs";
import path from "path";

const CSV_PATH = "./full-users.csv";   // ← cambia si se llama distinto
const OUT_PATH = "./id_passwords.json";

const csv = fs.readFileSync(CSV_PATH, "utf8");

// quita BOM si existe
const clean = csv.replace(/^\uFEFF/, "");

const lines = clean
  .split(/\r?\n/)
  .filter(l => l.trim() !== "");

const headers = lines[0].split(",");
const rows = lines.slice(1);

const idxId = headers.indexOf("id");
const idxPassword = headers.indexOf("password");

if (idxId === -1 || idxPassword === -1) {
  throw new Error("CSV inválido: faltan columnas id o password");
}

const out = {};

for (const line of rows) {
  // split CSV respetando comillas
  const cols = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g);
  if (!cols) continue;

  const id = cols[idxId];
  const password = cols[idxPassword]?.replace(/^"|"$/g, "");

  if (!id || !password) continue;

  out[id] = password;
}

fs.writeFileSync(
  OUT_PATH,
  JSON.stringify(out, null, 2),
  "utf8"
);

console.log(`✅ JSON generado: ${OUT_PATH}`);
console.log(`🔢 Total alumnos: ${Object.keys(out).length}`);
