/**
 * The device-owner check, as a seam.
 *
 * Asking the OS for Face ID / the device passcode is a native slice: it needs platform code this
 * web shell does not have. Every shell therefore answers `false`, and callers fall back to asking
 * for the current PIN. A native build replaces the body of this function; nothing else changes.
 *
 * Never fake a true here — a check that always passes is a lock with no lock in it.
 */
export async function confirmDeviceOwner(): Promise<boolean> {
  return false;
}
