/**
 * The names the services call themselves.
 *
 * One map, so the settings panel, the series card and the bind sheet cannot drift into calling the
 * same account "Kitsu" in one place and "kitsu" in another.
 */
import type { TrackerService } from "./types";

const LABELS: Record<TrackerService, string> = {
  kitsu: "Kitsu",
  mal: "MyAnimeList",
  anilist: "AniList",
  shikimori: "Shikimori",
  bangumi: "Bangumi",
  mangaupdates: "MangaUpdates",
};

export function trackerLabel(service: TrackerService): string {
  return LABELS[service] ?? service;
}