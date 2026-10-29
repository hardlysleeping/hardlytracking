/**
 * Which providers this build talks to.
 *
 * One list, built once, and a lookup by id prefix. A provider is only registered
 * when it is configured: an unconfigured Komga must not appear in the UI as an
 * empty shelf, because "no series" and "no server" are different answers.
 *
 * The dalvik host is the one provider that is probed rather than assumed: a
 * M-Extension-Server is a separate process on a loopback port, so "is it there?" is
 * a question only `/capabilities` can answer. A host that answers gets a provider
 * built from the APKs this device already installed; a host that does not answer is
 * a warning line, not a silent empty shelf.
 */
import { browserMihonTransport, createMihonProvider } from "./mihon";
import { createLocalProvider } from "./local";
import { DalvikClient, createDalvikProvider, type DalvikCapabilities, type InstalledExtension } from "./dalvik";
import { splitId, type SourceProvider } from "./source";
import type { LibraryStore } from "../lib/db/store";

export interface RegistryConfig {
  store: LibraryStore;
  /** Base path of the Mihon runtime; `null` disables the provider (local-only build). */
  mihonBase?: string | null;
  /**
   * Where the dalvik host is reachable: an absolute loopback URL in the packaged app,
   * the app's own `/api/dalvik` proxy in the browser. `null` disables it.
   */
  dalvikBase?: string | null;
  /** Probe override, so a test can hand the registry a stub host. */
  fetchImpl?: typeof fetch;
}

/** The live dalvik host: the client to install through, and the list it reads. */
export interface DalvikHost {
  baseUrl: string;
  client: DalvikClient;
  capabilities: DalvikCapabilities;
  /** The same array the provider reads — installing an APK pushes into it. */
  extensions: InstalledExtension[];
}

export interface ProviderSet {
  providers: SourceProvider[];
  /** `null` when no host answered `/capabilities`. */
  dalvik: DalvikHost | null;
  /** Configured hosts that did not answer. Shown, never swallowed. */
  warnings: string[];
}

export async function createProviders(config: RegistryConfig): Promise<ProviderSet> {
  const providers: SourceProvider[] = [];
  const warnings: string[] = [];

  const mihonBase = config.mihonBase === undefined ? "/api/mihon" : config.mihonBase;
  if (mihonBase !== null) providers.push(createMihonProvider(browserMihonTransport(mihonBase)));

  providers.push(createLocalProvider(config.store));

  let dalvik: DalvikHost | null = null;
  const dalvikBase = config.dalvikBase === undefined ? "/api/dalvik" : config.dalvikBase;
  if (dalvikBase !== null) {
    const client = new DalvikClient({ baseUrl: dalvikBase, ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }) });
    try {
      const capabilities = await client.capabilities();
      // Read once at boot so the sources of an APK installed last launch are there
      // before the first paint; the array stays live afterwards.
      const extensions = await config.store.listExtensions();
      providers.push(createDalvikProvider({ client, extensions }));
      dalvik = { baseUrl: dalvikBase, client, capabilities, extensions };
    } catch (error) {
      warnings.push(`dalvik: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { providers, dalvik, warnings };
}

export function providerFor(providers: SourceProvider[], id: string): SourceProvider {
  const { provider } = splitId(id);
  const found = providers.find((p) => p.kind === provider);
  if (!found) throw new Error(`no ${provider} provider is configured`);
  return found;
}
