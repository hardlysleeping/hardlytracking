/** A session-local screen curtain, not authentication or encryption. */
export class PrivacyState {
  locked = $state(false);
  bandCollapsed = $state(false);
  revision = $state(0);
  #priorFold = false;

  toggleBand(): void {
    if (!this.locked) this.bandCollapsed = !this.bandCollapsed;
  }

  lock(): void {
    if (this.locked) return;
    this.#priorFold = this.bandCollapsed;
    this.bandCollapsed = true;
    this.locked = true;
    this.revision++;
  }

  unlock(): void {
    if (!this.locked) return;
    this.locked = false;
    this.bandCollapsed = this.#priorFold;
    this.revision++;
  }
}
export const privacy = new PrivacyState();
