import { useCallback, useMemo, useState } from "react";
import {
  readNestedChats,
  readRunningOnly,
  readViewOptionsOpen,
  writeNestedChats,
  writeRunningOnly,
  writeViewOptionsOpen,
} from "../../lib/chatViewPrefs";

/**
 * The chat list's view preferences, read once at mount and written through on
 * every change. See `lib/chatViewPrefs.ts` for why they are global rather than
 * per-project.
 *
 * One hook (rather than three `useState`s in ProjectView) because these are one
 * concept and travel together: `ProjectView` needs them to pick the forest
 * builder, `SessionSidebar` needs them to render the badge and the panel, so the
 * whole object is drilled down as a single prop instead of six.
 */
export interface ChatViewPrefs {
  /** Nest chats under the chat that created them. */
  nested: boolean;
  setNested: (value: boolean) => void;
  /** Show only chats with a live turn right now. */
  runningOnly: boolean;
  setRunningOnly: (value: boolean) => void;
  /** Whether the view-options panel is expanded. */
  optionsOpen: boolean;
  toggleOptionsOpen: () => void;
}

export function useChatViewPrefs(): ChatViewPrefs {
  const [nested, setNestedState] = useState(readNestedChats);
  const [runningOnly, setRunningOnlyState] = useState(readRunningOnly);
  const [optionsOpen, setOptionsOpenState] = useState(readViewOptionsOpen);

  const setNested = useCallback((value: boolean) => {
    setNestedState(value);
    writeNestedChats(value);
  }, []);

  const setRunningOnly = useCallback((value: boolean) => {
    setRunningOnlyState(value);
    writeRunningOnly(value);
  }, []);

  const toggleOptionsOpen = useCallback(() => {
    setOptionsOpenState((open) => {
      writeViewOptionsOpen(!open);
      return !open;
    });
  }, []);

  return useMemo(
    () => ({ nested, setNested, runningOnly, setRunningOnly, optionsOpen, toggleOptionsOpen }),
    [nested, setNested, runningOnly, setRunningOnly, optionsOpen, toggleOptionsOpen],
  );
}
