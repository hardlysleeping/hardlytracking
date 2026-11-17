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
    id: "history",
    label: "History",
    href: "/history",
    icon: "M12 8v5l3 2M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3 3v4h4",
  },
  {
    id: "search",
    label: "Search",
    href: "/search",
    icon: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16.2 16.2 21 21",
  },
  {
    id: "browse",
    label: "Browse",
    href: "/browse",
    icon: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z",
  },
  {
    // The page ids are the bar's saved order, so `more` stays the id even though the page it opens
    // is Settings: renaming the id would silently drop this destination from every bar that already
    // names it.
    id: "more",
    label: "Settings",
    href: "/settings",
    icon: "M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1ZM12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z",
  },
];

/** Routes that are pushed on top of a destination, and the destination they sit on. */
const UNDER: Record<string, string> = {
  updates: "library",
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
  // Downloads is a Library section now (Titles / Updates / Downloads), not a page in More.
  downloads: "library",
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
  if (route.name === "updates" || route.name === "series" || route.name === "read") return "/library";
  if (route.name === "downloads") return "/downloads";
  if (route.name === "source" || route.name === "extensions") return "/browse";
  // A package page is reached from the Extensions list, which is the index of packages.
  if (route.name === "software") return "/extensions";
  // `/more` and `/settings` draw the same page, and Settings is now the destination, so every page
  // pushed under `more` returns there.
  if (route.name === "settings") return null;
  return "/settings";
}
