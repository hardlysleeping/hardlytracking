/**
 * Chrome: the two attributes that decide how much room the content gets.
 *
 * `data-margins`, `data-space` and `data-density` live on `<html>`, so one write changes every screen
 * and no component has to agree with another about padding. It is the HardlyReader idea — a layout
 * setting, applied once, not a class each view has to remember to ask for.
 *
 * The settings arrive asynchronously (they live in the library database), so this is an effect over
 * `settings`, and the defaults are the comfortable ones: an app that has not loaded its preferences
 * yet must not look like it was told to remove all margins.
 */
import { settings } from "../state/settings.svelte";
import { chromeAttributes } from "./view-options";

let started = false;

/** Apply the current settings to `<html>`. Safe to call more than once. */
export function applyChrome(): void {
  const attributes = chromeAttributes({
    margins: settings.contentMargins,
    maximize: settings.maximizeSpace,
    density: settings.libraryDensity,
  });
  for (const [name, value] of Object.entries(attributes)) {
    document.documentElement.setAttribute(name, value);
  }
}

/** Start following the settings. Called once from App. */
export function startChrome(): void {
  if (started) return;
  started = true;
  applyChrome();
  // The settings store is a class with $state fields; reading them inside an effect is what makes
  // a change in Settings reach the document without every screen subscribing.
  $effect.root(() => {
    $effect(() => {
      // Touch each value so the effect re-runs when one changes.
      void settings.contentMargins;
      void settings.maximizeSpace;
      void settings.libraryDensity;
      applyChrome();
    });
  });
}
