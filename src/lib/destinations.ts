/**
 * The destinations, and which one a route belongs to.
 *
 * A series page or a reader is not a destination: it is pushed on top of one, so the bar keeps
 * saying where you are. That is why the shell asks `destinationOf(route)` rather than matching
 * route names itself.
 */
import type { Route } from "./nav";

export interface Destination {
  id: string;
  label: string;
  /** 24×24 path data, stroked. Kept inline so the shell has no icon dependency. */
  icon: string;
  href: string;
}

export const DESTINATIONS: Destination[] = [
  {
    id: "library",
    label: "Library",
    href: "/library",
    icon: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  },
  {
    id: "updates",
    label: "Updates",
    href: "/updates",
    icon: "M12 4v10m0 0-3.5-3.5M12 14l3.5-3.5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2",
  },
  {
    id: "browse",
    label: "Browse",
    href: "/browse",
    icon: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z",
  },
  {
    id: "search",
    label: "Search",
    href: "/search",
    icon: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16.2 16.2 21 21",
  },
  {
    id: "history",
    label: "History",
    href: "/history",
    icon: "M12 8v5l3 2M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3 3v4h4",
  },
  {
    id: "more",
    label: "More",
    href: "/more",
    icon: "M12 5h.01M12 12h.01M12 19h.01",
  },
];

/** Routes that are pushed on top of a destination, and the destination they sit on. */
const UNDER: Record<string, string> = {
  series: "library",
  read: "library",
  source: "browse",
  extensions: "browse",
  software: "browse",
  settings: "more",
  appearance: "more",
  stats: "more",
  sync: "more",
  messages: "more",
  downloads: "more",
  backup: "more",
  account: "more",
};

export function destinationOf(route: Route): string {
  if (DESTINATIONS.some((d) => d.id === route.name)) return route.name;
  return UNDER[route.name] ?? "library";
}

/** A pushed route gets a back arrow to its destination. */
export function backHref(route: Route): string | null {
  if (DESTINATIONS.some((d) => d.id === route.name)) return null;
  if (route.name === "series" || route.name === "read") return "/library";
  if (route.name === "source" || route.name === "extensions") return "/browse";
  // A package page is reached from the Extensions list, which is the index of packages.
  if (route.name === "software") return "/extensions";
  // Messages are reached from the bell in Settings, so back goes there, not to More.
  if (route.name === "messages") return "/settings";
  if (route.name === "appearance" || route.name === "stats") return "/more";
  return "/more";
}
