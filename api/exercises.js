import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

async function loadJsonFile(filename) {
  const text = await fs.readFile(path.join(DATA_DIR, filename), "utf8");
  return JSON.parse(text);
}

async function listExercisesWithSongs() {
  const files = await fs.readdir(DATA_DIR);
  const songs = new Map();
  const exercises = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const json = await loadJsonFile(file);
      if (json?.type === "lyrics-base" && json.song?.id) {
        songs.set(json.song.id, {
          title: json.song.title,
          artist: json.song.artist,
          youtubeId: json.song.youtubeId,
          file,
        });
      }
      if (json?.type === "exercise" && json.exercise?.songId) {
        exercises.push({
          file,
          id: json.exercise.id,
          songId: json.exercise.songId,
          name: json.exercise.name,
          description: json.exercise.description ?? "",
          questionWordIds: json.exercise.questionWordIds ?? [],
        });
      }
    } catch (error) {
      console.warn("Skipping invalid data file:", file, error);
    }
  }

  return exercises.map((item) => ({ ...item, song: songs.get(item.songId) ?? null }));
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    res.json(await listExercisesWithSongs());
  } catch (error) {
    console.error("Error listing exercises:", error);
    res.status(500).json({ error: "Server error" });
  }
}
