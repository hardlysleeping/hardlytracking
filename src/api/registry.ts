/**
 * Which providers this build talks to.
 *
 * One list, built once, and a lookup by id prefix. A provider is only registered
 * when it is configured: an unconfigured Komga must not appear in the UI as an
 * empty shelf, because "no series" and "no server" are different answers.
 */
import { browserMihonTransport, createMihonProvider } from "./mihon";
import { createLocalProvider } from "./local";
import { splitId, type SourceProvider } from "./source";
import type { LibraryStore } from "../lib/db/store";

export interface RegistryConfig {
  store: LibraryStore;
  /** Base path of the Mihon runtime; `null` disables the provider (local-only build). */
  mihonBase?: string | null;
}

export function createProviders(config: RegistryConfig): SourceProvider[] {
  const providers: SourceProvider[] = [];
  const mihonBase = config.mihonBase === undefined ? "/api/mihon" : config.mihonBase;
  if (mihonBase !== null) providers.push(createMihonProvider(browserMihonTransport(mihonBase)));
  providers.push(createLocalProvider(config.store));
  return providers;
}

export function providerFor(providers: SourceProvider[], id: string): SourceProvider {
  const { provider } = splitId(id);
  const found = providers.find((p) => p.kind === provider);
  if (!found) throw new Error(`no ${provider} provider is configured`);
  return found;
}
