import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

async function findSongById(songId) {
  const files = await fs.readdir(DATA_DIR);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const text = await fs.readFile(path.join(DATA_DIR, file), "utf8");
      const json = JSON.parse(text);
      if (json?.type === "lyrics-base" && json.song?.id === songId) {
        return json;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { songId } = req.query;
  try {
    const song = await findSongById(songId);
    if (!song) {
      return res.status(404).json({ error: "Song not found" });
    }
    res.json(song);
  } catch (error) {
    console.error("Error fetching song:", error);
    res.status(500).json({ error: "Server error" });
  }
}
