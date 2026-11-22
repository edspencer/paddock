// jsdom has no Web Speech API. This fake stands in for the browser's
// SpeechRecognition so the dictation tests can drive results, errors and `end`
// by hand. `install()` puts it on `window` under the given name; `uninstall()`
// removes both names again.
import { vi } from "vitest";
import type {
  BrowserSpeechRecognition,
  BrowserSpeechRecognitionErrorEvent,
  BrowserSpeechRecognitionEvent,
} from "../lib/speechRecognition";

export class FakeSpeechRecognition implements BrowserSpeechRecognition {
  /** Every instance constructed since the last `install()`, oldest first. */
  static instances: FakeSpeechRecognition[] = [];

  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null = null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;

  start = vi.fn();
  /** Like the browser, `stop` ends the session (after any pending results). */
  stop = vi.fn(() => this.end());
  /** Like the browser, `abort` reports `aborted` and then ends. */
  abort = vi.fn(() => {
    this.onerror?.({ error: "aborted" });
    this.end();
  });

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  /** Deliver a result event: `[transcript, isFinal]` per result in the list. */
  emit(results: Array<[string, boolean]>, resultIndex = 0) {
    const list = results.map(([transcript, isFinal]) =>
      Object.assign([{ transcript, confidence: 1 }], { isFinal }),
    );
    this.onresult?.({
      resultIndex,
      results: list as unknown as SpeechRecognitionResultList,
    });
  }

  /** Deliver an error event with the given spec code (e.g. `no-speech`). */
  fail(error: string) {
    this.onerror?.({ error });
  }

  /** Deliver `end`, as the browser does after stop, abort, error or silence. */
  end() {
    this.onend?.();
  }

  static latest(): FakeSpeechRecognition {
    const rec = FakeSpeechRecognition.instances.at(-1);
    if (!rec) throw new Error("no SpeechRecognition was constructed");
    return rec;
  }

  static install(name: "SpeechRecognition" | "webkitSpeechRecognition" = "SpeechRecognition") {
    FakeSpeechRecognition.instances = [];
    (window as unknown as Record<string, unknown>)[name] = FakeSpeechRecognition;
  }

  static uninstall() {
    const w = window as unknown as Record<string, unknown>;
    delete w.SpeechRecognition;
    delete w.webkitSpeechRecognition;
  }
}
