<script lang="ts">
  /**
   * The one door to the screen-curtain PIN: set, unlock, change, remove.
   *
   * Both places that need it open this sheet — the Lock seat in the library band and the Privacy
   * section in Settings — so the copy, the digit rules and the wrong-PIN count cannot drift apart.
   * The digits live in component state only: no input element (so no browser autofill), no URL, and
   * the stored value is the salted hash from `lib/pin`, never the PIN.
   */
  import Sheet from "./Sheet.svelte";
  import { library } from "../state/library.svelte";
  import { privacy } from "../state/privacy.svelte";
  import { PIN_MAX, PIN_MIN, pinValid } from "../lib/pin";

  type Mode = "set" | "unlock" | "change" | "remove";
  type Step = "current" | "new" | "confirm" | "unlock";
  type Failure = "invalid" | "exists" | "missing" | "wrong";

  let {
    open,
    mode,
    onclose,
    ondone,
  }: { open: boolean; mode: Mode; onclose: () => void; ondone?: () => void } = $props();

  let step = $state<Step>("unlock");
  let entry = $state("");
  let currentPin = $state("");
  let newPin = $state("");
  let error = $state("");
  let busy = $state(false);

  const FAILURE: Record<Failure, string> = {
    invalid: `Use ${PIN_MIN} to ${PIN_MAX} digits.`,
    exists: "A PIN is already set — use Change PIN instead.",
    missing: "No PIN is set on this device.",
    wrong: "That PIN is not right.",
  };

  // Each time the sheet opens (or is asked for a different job), start at the first step with
  // nothing typed. A half-finished change must never be resumed by the next press.
  $effect(() => {
    const opening = open;
    const job = mode;
    if (!opening) return;
    step = job === "unlock" ? "unlock" : job === "set" ? "new" : "current";
    entry = "";
    currentPin = "";
    newPin = "";
    error = "";
    busy = false;
  });

  const heading = $derived(
    mode === "unlock"
      ? "Enter your PIN"
      : mode === "remove"
        ? "Remove the PIN"
        : step === "current"
          ? "Enter the current PIN"
          : step === "confirm"
            ? mode === "set"
              ? "Confirm the PIN"
              : "Confirm the new PIN"
            : mode === "set"
              ? "Set a PIN"
              : "Choose a new PIN",
  );

  const action = $derived(
    step === "unlock"
      ? "Unlock"
      : mode === "remove"
        ? "Remove PIN"
        : step === "confirm"
          ? mode === "set"
            ? "Set PIN"
            : "Change PIN"
          : "Continue",
  );

  const canSubmit = $derived(!busy && pinValid(entry));

  function type(digit: string): void {
    if (busy || entry.length >= PIN_MAX) return;
    entry += digit;
    error = "";
  }

  function back(): void {
    if (busy) return;
    entry = entry.slice(0, -1);
    error = "";
  }

  function finish(): void {
    entry = "";
    newPin = "";
    currentPin = "";
    ondone?.();
    onclose();
  }

  async function submit(): Promise<void> {
    if (busy) return;
    if (step === "unlock") {
      busy = true;
      const result = await privacy.attemptUnlock(entry);
      busy = false;
      entry = "";
      if (result === "unlocked") {
        error = "";
        onclose();
        return;
      }
      error = privacy.notice || "That PIN is not right.";
      return;
    }
    if (!pinValid(entry)) {
      error = FAILURE.invalid;
      return;
    }
    if (mode === "remove") {
      busy = true;
      const result = await library.clearPin(entry);
      busy = false;
      if (!result.ok) {
        error = FAILURE[result.reason];
        entry = "";
        return;
      }
      finish();
      return;
    }
    if (step === "current") {
      // Ask now, not after the new code has been typed twice: a wrong current PIN is refused on
      // the step it was entered, and nothing is written until the full change succeeds.
      busy = true;
      const owned = await library.confirmPin(entry);
      busy = false;
      if (!owned) {
        error = FAILURE.wrong;
        entry = "";
        return;
      }
      currentPin = entry;
      entry = "";
      step = "new";
      return;
    }
    if (step === "new") {
      newPin = entry;
      entry = "";
      step = "confirm";
      return;
    }
    // Confirm: the second entry is the one that is stored, and it must match the first.
    if (entry !== newPin) {
      error = "Those digits do not match — start again.";
      entry = "";
      newPin = "";
      step = "new";
      return;
    }
    busy = true;
    const result = mode === "set" ? await library.setPin(newPin) : await library.changePin(currentPin, newPin);
    busy = false;
    if (!result.ok) {
      error = FAILURE[result.reason];
      entry = "";
      newPin = "";
      currentPin = "";
      step = mode === "set" ? "new" : "current";
      return;
    }
    finish();
  }
</script>

<Sheet {open} title={heading} {onclose}>
  <p class="note">
    Local screen privacy only: the PIN keeps hidden shelves off the screen. It is stored as a salted
    hash, never in plain text, and travels with your HardlySync account so one PIN opens the app on
    every device. It is not encryption — the library itself is not encrypted.
  </p>

  <div class="dots" aria-hidden="true">
    {#each Array(PIN_MAX) as _, index (index)}<i class:on={index < entry.length}></i>{/each}
  </div>
  <p class="status" role="status" aria-live="polite">{error || (mode === "unlock" ? privacy.notice : "")}</p>

  <div class="pad" role="group" aria-label="PIN digits">
    {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as digit (digit)}
      <button type="button" class="key" aria-label={digit} onclick={() => type(digit)}>{digit}</button>
    {/each}
    <span class="blank" aria-hidden="true"></span>
    <button type="button" class="key" aria-label="0" onclick={() => type("0")}>0</button>
    <button type="button" class="key del" aria-label="Delete" onclick={back}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11v12H9L3 12zM12 9l5 6M17 9l-5 6" /></svg>
    </button>
  </div>

  <div class="acts">
    <button class="btn ghost" onclick={onclose}>Cancel</button>
    <button class="btn primary" disabled={!canSubmit} onclick={() => void submit()}>{action}</button>
  </div>
</Sheet>

<style>
  .note {
    margin: 0;
    color: var(--text-2);
    font-size: var(--t-sm);
    line-height: 1.55;
    max-width: 52ch;
  }

  .dots {
    display: flex;
    justify-content: center;
    gap: var(--s2);
    min-height: 20px;
    padding: var(--s1) 0;
  }
  .dots i {
    width: 12px;
    height: 12px;
    border: 1.5px solid var(--text-3);
    border-radius: 50%;
  }
  .dots i.on { background: var(--accent); border-color: var(--accent); }

  /* A refusal and a count are the same line: one place to look after a wrong digit. */
  .status {
    margin: 0;
    min-height: 20px;
    color: var(--tone-lock-closed, var(--danger, #d9534f));
    font-size: var(--t-sm);
    text-align: center;
  }

  .pad {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--s2);
    max-width: 320px;
    margin: 0 auto;
    width: 100%;
  }
  .key {
    min-height: 52px;
    border: 1px solid var(--line);
    border-radius: var(--r2);
    background: var(--surface-2);
    color: var(--text-1);
    font: inherit;
    font-size: var(--t-lg);
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }
  .key:hover { background: var(--surface-3, var(--elevated)); }
  .key:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .key:active { background: color-mix(in srgb, var(--text-1) 16%, transparent); }
  .key.del { display: grid; place-items: center; color: var(--text-2); }
  .key svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .blank { min-height: 52px; }

  .acts {
    display: flex;
    justify-content: flex-end;
    gap: var(--s2);
  }
  .acts .btn { min-height: 44px; }
</style>
