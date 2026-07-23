import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../../lib/api";
import { readAttachmentRefs, writeAttachmentRefs } from "../../lib/attachmentRefs";
import { isTypeAllowed as isAttachmentTypeAllowed } from "../../lib/attachments";
import type { AttachmentRef, AttachmentsConfig, AttachmentsOverride } from "../../lib/types";

/** Inputs the composer-attachments hook needs from {@link ChatPane} (issue #328). */
export interface UseComposerAttachmentsParams {
  projectSlug: string;
  isProjectChat: boolean;
  initialSessionId?: string;
  /** Instance-default inbound-attachment config (GET /api/models). Null until fetched. */
  attachmentsDefault: AttachmentsConfig | null;
  /** Per-project override from the Project DTO. */
  projectAttachments?: AttachmentsOverride;
  /** ChatPane's session ref — uploads target the (possibly not-yet-known) session. */
  sessionRef: MutableRefObject<string | null>;
  /** ChatPane's composer-level error setter (validation + upload failures). */
  setError: Dispatch<SetStateAction<string | null>>;
}

/** What the hook hands back — staged tray state plus the composer event handlers. */
export interface ComposerAttachments {
  attachments: AttachmentRef[];
  /** Mirrors `attachments` for the send callback (like `queuedRef`), read at send time. */
  attachRef: MutableRefObject<AttachmentRef[]>;
  setAttachments: Dispatch<SetStateAction<AttachmentRef[]>>;
  uploading: boolean;
  dragOver: boolean;
  fileInputRef: MutableRefObject<HTMLInputElement | null>;
  attachConfig: AttachmentsConfig;
  attachEnabled: boolean;
  addFiles: (incoming: File[]) => Promise<void>;
  removeAttachment: (id: string) => void;
  onComposerPaste: (e: React.ClipboardEvent) => void;
  onComposerDragOver: (e: React.DragEvent) => void;
  onComposerDragLeave: (e: React.DragEvent) => void;
  onComposerDrop: (e: React.DragEvent) => void;
  onPickFiles: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

/**
 * The composer's staged-attachment state + paste/drag/drop/pick handlers (issue
 * #328). Extracted from ChatPane (issue #403) but behavior-identical: the tray
 * state stays here and is surfaced back via the return value (ChatPane's send path
 * reads `attachRef.current` and calls `setAttachments`). Files the user picks are
 * client-validated (a UX guardrail; the server re-validates), uploaded to the
 * store, and their refs appended to the tray; the refs are persisted per chat so
 * they survive a chat switch / reload (#346, the bytes live durably server-side).
 */
export function useComposerAttachments({
  projectSlug,
  isProjectChat,
  initialSessionId,
  attachmentsDefault,
  projectAttachments,
  sessionRef,
  setError,
}: UseComposerAttachmentsParams): ComposerAttachments {
  // Files the user has picked/dropped/pasted and uploaded to the store, held
  // until send. `attachRef` mirrors it for the send callback (like `queuedRef`).
  // Issue #346: seed from any staged refs persisted for this chat so they survive
  // a chat switch / reload instead of being silently dropped (mirrors the composer
  // draft; the bytes live durably server-side, so only the refs need saving —
  // see lib/attachmentRefs.ts).
  const [attachments, setAttachments] = useState<AttachmentRef[]>(() =>
    readAttachmentRefs(initialSessionId, projectSlug),
  );
  const attachRef = useRef<AttachmentRef[]>([]);
  attachRef.current = attachments;
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Issue #346: persist the staged composer attachments so they survive a chat
  // switch / reload too — otherwise navigating away and back silently drops them
  // while the draft text right next to them is restored. Every tray mutation
  // (add / remove / clear-on-send) flows through setAttachments, so keying off
  // `attachments` covers them all; writing an empty list forgets the key. Only the
  // lightweight refs are stored (the bytes are durable server-side).
  useEffect(() => {
    writeAttachmentRefs(initialSessionId, projectSlug, attachments);
  }, [attachments, initialSessionId, projectSlug]);

  // The composer's effective attachment config: the per-project override wins
  // field-wise over the instance default (from /api/models). Allow-all defaults
  // apply until the fetch lands. Mirrors the server's resolveAttachmentsConfig.
  const attachConfig = useMemo<AttachmentsConfig>(() => {
    const d = attachmentsDefault ?? {
      enabled: true,
      maxFileSizeMb: 25,
      maxFilesPerMessage: 10,
      allowedTypes: ["*"],
    };
    const o = projectAttachments ?? {};
    return {
      enabled: o.enabled ?? d.enabled,
      maxFileSizeMb: o.maxFileSizeMb ?? d.maxFileSizeMb,
      maxFilesPerMessage: o.maxFilesPerMessage ?? d.maxFilesPerMessage,
      allowedTypes: o.allowedTypes ?? d.allowedTypes,
    };
  }, [attachmentsDefault, projectAttachments]);
  // Attachments are project-chat-only (the upload endpoint is project-scoped) and
  // gated by the effective `enabled` knob.
  const attachEnabled = isProjectChat && attachConfig.enabled;

  // Client-side validate (UX guardrail; the server re-validates authoritatively),
  // then upload accepted files and append their refs to the tray.
  const addFiles = useCallback(
    async (incoming: File[]) => {
      if (!attachEnabled || incoming.length === 0) return;
      const maxBytes = attachConfig.maxFileSizeMb * 1024 * 1024;
      const room = attachConfig.maxFilesPerMessage - attachRef.current.length;
      if (room <= 0) {
        setError(`You can attach at most ${attachConfig.maxFilesPerMessage} files per message.`);
        return;
      }
      const accepted: File[] = [];
      for (const f of incoming.slice(0, room)) {
        if (!isAttachmentTypeAllowed(attachConfig.allowedTypes, f.type, f.name)) {
          setError(`File type not allowed: ${f.name}`);
          continue;
        }
        if (f.size > maxBytes) {
          setError(`File too large (max ${attachConfig.maxFileSizeMb} MB): ${f.name}`);
          continue;
        }
        accepted.push(f);
      }
      if (incoming.length > room) {
        setError(`You can attach at most ${attachConfig.maxFilesPerMessage} files per message.`);
      }
      if (accepted.length === 0) return;
      setUploading(true);
      try {
        const { files } = await api.uploadAttachments(
          projectSlug,
          sessionRef.current ?? "new",
          accepted,
        );
        setAttachments((prev) => [...prev, ...files]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setUploading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attachEnabled, attachConfig, projectSlug],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Cmd/Ctrl+V of a screenshot (or any file) into the composer (#328).
  const onComposerPaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!attachEnabled) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [attachEnabled, addFiles],
  );

  // Drag-and-drop onto the composer (#328). `dragOver` highlights the drop zone.
  const onComposerDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!attachEnabled) return;
      if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
        e.preventDefault();
        setDragOver(true);
      }
    },
    [attachEnabled],
  );
  const onComposerDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when the pointer actually leaves the drop zone (not a child).
    if (e.currentTarget === e.target) setDragOver(false);
  }, []);
  const onComposerDrop = useCallback(
    (e: React.DragEvent) => {
      if (!attachEnabled) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        setDragOver(false);
        void addFiles(files);
      }
    },
    [attachEnabled, addFiles],
  );
  const onPickFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) void addFiles(files);
      // Reset so re-picking the same file fires onChange again.
      e.target.value = "";
    },
    [addFiles],
  );

  return {
    attachments,
    attachRef,
    setAttachments,
    uploading,
    dragOver,
    fileInputRef,
    attachConfig,
    attachEnabled,
    addFiles,
    removeAttachment,
    onComposerPaste,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
    onPickFiles,
  };
}
