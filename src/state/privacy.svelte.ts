/** A session-local screen curtain, not authentication or encryption. */
export class PrivacyState {
  locked = $state(false);
  bandCollapsed = $state(false);
  revision = $state(0);
  #priorFold = false;

  /** The tab works in every state, including locked: it is the way back to the band. */
  toggleBand(): void {
    this.bandCollapsed = !this.bandCollapsed;
    // A fold the reader chose while the curtain was down is their fold. Unlocking must not
    // re-collapse the band under them, so the memory is what they last asked for.
    if (this.locked) this.#priorFold = this.bandCollapsed;
  }

  lock(): void {
    if (this.locked) return;
    this.#priorFold = this.bandCollapsed;
    // Locking folds the band. The curtain is already down; leaving the controls on screen beside
    // it says the shelves are one press away, which is the opposite of the point.
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
