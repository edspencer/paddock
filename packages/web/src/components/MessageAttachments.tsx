import { useState } from "react";
import type { AttachmentRef } from "../lib/types";
import { attachmentRawUrl, formatFileSize } from "../lib/attachments";
import { FileIcon, AlertIcon, XIcon } from "./icons";

/**
 * Renders the files a user attached to a message (issue #328), above the bubble
 * text. Images show as thumbnails (click → lightbox); every other kind shows as
 * a compact chip (icon · name · size) linking to the raw bytes. Used both live
 * (from the composer tray) and on reload (parsed from the message wrapper), so a
 * refresh renders identically — the bytes come from `/api/chat-files/:id`.
 */
export function MessageAttachments({ attachments }: { attachments: AttachmentRef[] }) {
  if (attachments.length === 0) return null;
  return (
    <div
      className="mb-1 flex flex-wrap justify-end gap-2"
      data-testid="message-attachments"
    >
      {attachments.map((a) => (
        <AttachmentItem key={a.id} attachment={a} />
      ))}
    </div>
  );
}

function AttachmentItem({ attachment }: { attachment: AttachmentRef }) {
  const url = attachmentRawUrl(attachment.id);
  if (attachment.kind === "image") {
    return <ImageThumb src={url} filename={attachment.filename} />;
  }
  const size = formatFileSize(attachment.size);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={attachment.filename}
      data-testid="attachment-chip"
      className="flex max-w-[14rem] items-center gap-2 rounded-xl bg-white px-3 py-2 text-left text-xs shadow-sm ring-1 ring-paddock-200/70 hover:ring-accent dark:bg-paddock-900 dark:ring-paddock-800"
    >
      <FileIcon width={16} height={16} className="shrink-0 text-paddock-400" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-ink dark:text-ink-dark">
          {attachment.filename}
        </span>
        <span className="uppercase tracking-wide text-[10px] text-paddock-400">
          {attachment.kind}
          {size ? ` · ${size}` : ""}
        </span>
      </span>
    </a>
  );
}

/**
 * A staged attachment in the composer tray (issue #328) — a small preview with a
 * ✕ to remove it before send. Images preview as a thumbnail; other kinds as a
 * chip (icon · name · size). Distinct from {@link MessageAttachments} (which is
 * read-only, in the transcript) by the remove affordance.
 */
export function AttachmentTrayItem({
  attachment,
  onRemove,
}: {
  attachment: AttachmentRef;
  onRemove: (id: string) => void;
}) {
  const url = attachmentRawUrl(attachment.id);
  const isImage = attachment.kind === "image";
  const size = formatFileSize(attachment.size);
  return (
    <span
      data-testid="attachment-tray-item"
      className="group relative flex items-center gap-2 rounded-xl bg-white py-2 pl-2 pr-7 text-xs shadow-sm ring-1 ring-paddock-200/70 dark:bg-paddock-900 dark:ring-paddock-800"
    >
      {isImage ? (
        <img
          src={url}
          alt={attachment.filename}
          className="h-9 w-9 shrink-0 rounded-md object-cover"
        />
      ) : (
        <FileIcon width={16} height={16} className="shrink-0 text-paddock-400" />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="max-w-[10rem] truncate font-medium text-ink dark:text-ink-dark">
          {attachment.filename}
        </span>
        <span className="uppercase tracking-wide text-[10px] text-paddock-400">
          {attachment.kind}
          {size ? ` · ${size}` : ""}
        </span>
      </span>
      <button
        type="button"
        onClick={() => onRemove(attachment.id)}
        aria-label={`Remove ${attachment.filename}`}
        title="Remove"
        data-testid="attachment-remove"
        className="absolute right-1 top-1 rounded-full p-0.5 text-paddock-400 hover:bg-paddock-100 hover:text-paddock-700 dark:hover:bg-paddock-800"
      >
        <XIcon width={12} height={12} />
      </button>
    </span>
  );
}

function ImageThumb({ src, filename }: { src: string; filename: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs text-rose-700 shadow-sm ring-1 ring-paddock-200/70 dark:bg-paddock-900 dark:text-rose-300 dark:ring-paddock-800">
        <AlertIcon width={14} height={14} />
        {filename}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={filename}
        data-testid="attachment-thumb"
        className="block overflow-hidden rounded-xl ring-1 ring-paddock-200/70 hover:ring-accent dark:ring-paddock-800"
      >
        <img
          src={src}
          alt={filename}
          onError={() => setFailed(true)}
          className="h-24 w-24 object-cover"
        />
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-label={filename}
        >
          <img
            src={src}
            alt={filename}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
          />
        </div>
      ) : null}
    </>
  );
}
