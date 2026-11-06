/** Temporary, device-session-only history suppression. Never exported or persisted as a preference. */
class IncognitoState {
  active = $state(false);
  toggle(): void { this.active = !this.active; }
}

export const incognito = new IncognitoState();
