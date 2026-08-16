import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMigrationOffer } from "../lib/useMigrationOffer";
import { MigrationDialog } from "./MigrationDialog";
import { Toast } from "./Toast";
import { XIcon } from "./icons";
import { Button } from "./ui";

/**
 * The `own → host` transcript-migration offer (#882).
 *
 * Paddock's default profile runs `claude.transcripts: own`, which keeps a
 * project's chats in its own `.chats/` and out of the user's real `~/.claude`.
 * That is the right default for trying Paddock and the wrong one for keeping it:
 * a user who has decided they like it wants their Paddock chats and their
 * terminal history to be one history. #882 is the one-button path between the
 * two, and **this banner is the entire discovery surface for it** — nobody goes
 * looking in Config for a feature they have never heard of. If it is easy to
 * miss, or annoying enough to be muted reflexively, the feature may as well not
 * ship.
 *
 * ## Where it sits, and why it is not a bar
 *
 * In {@link FleetReadout}'s existing negative space, at the right-hand end of
 * the strip that already reads `■ 0 RUNNING ■ 22 UNREAD │ Idle`. Ed settled the
 * placement in #882: the lever is instance-level, so an instance-level strip is
 * where it belongs; the strip is on every route, so the offer does not depend on
 * visiting Config; and root Home is organised around "what needs me? before what
 * is this?" (#870), which a migration offer is neither.
 *
 * It is a chip in space that is already empty, not a new full-width bar and not
 * a rearrangement of the readout — so on an instance with nothing to migrate,
 * which is most of them, this file changes zero pixels.
 *
 * ## Why it is the loudest thing in a strip that is deliberately quiet
 *
 * `FleetReadout`'s own rule is that the only thing that moves in it is the
 * clocks, because that is data. This chip does not move — but it is the only
 * accent-filled element in a strip whose channels are `bg-surface`, so it
 * visually outranks a running turn. That is deliberate and it is bounded: it is
 * the one-time announcement of something the user cannot otherwise find out,
 * and one click removes it for good. A permanent decoration would not have
 * earned it; a dismissible offer does.
 *
 * ## The copy
 *
 * Three drafts, in a top bar's worth of width:
 *
 *   A. `Chats are separate from ~/.claude` · **Merge**
 *   B. `Merge chats into ~/.claude`
 *   C. `~/.claude can't see these chats` · **Merge**
 *
 * **A ships.** The news is the isolation, not the button: B reads as an offer
 * to someone who already knows their chats are partitioned, and that person is
 * not who the banner is for. A states the arrangement as a neutral property of
 * it — "separate", not "missing", "hidden" or "cut off" — so the user who is
 * perfectly happy reads a fact rather than a fault, and the accent verb makes
 * the second half an offer rather than a diagnosis. C says the same thing as A
 * but personifies the directory, which makes it sound broken.
 *
 * ## What it deliberately does not say
 *
 * A count. `pendingChats` is contractually a LOWER BOUND and is legitimately `0`
 * on an eligible instance (a project whose `.chats/` holds only an agent
 * `memory/` directory), so a chip reading "0 chats to merge" is reachable, and
 * "1,204 chats" would be a number that is quietly wrong. The count belongs in
 * the dialog, where there is room to qualify it. Keeping it out of the strip
 * also means no width of number can push the layout around.
 */
export function MigrationOfferBanner() {
  const { showBanner, dismiss } = useMigrationOffer();
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // A successful migration makes the probe's answer wrong, and the probe is
  // memoised for the lifetime of the page — `invalidateMigrationProbe()` drops
  // the cache but cannot re-render an already-mounted consumer. Rather than
  // give the hook a subscription for one event that is always immediately
  // followed by a server restart, the chip just stops rendering here.
  const [migrated, setMigrated] = useState(false);

  // The toast outlives the chip: dismissing removes the banner and the message
  // that says where it went is the only thing left rendering.
  const onDismiss = () => {
    dismiss();
    setToast("Hidden on this browser. The migration is still on the Config screen.");
  };

  return (
    <>
      {showBanner && !migrated && (
        <div
          data-testid="migration-offer"
          className="flex h-6 shrink-0 items-center rounded-md border border-accent-edge bg-accent-soft pr-0.5"
        >
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            title="Your chats live in Paddock's own store, not in ~/.claude. Merge them in so the Claude Code CLI sees them too."
            // Spelled out rather than left to the contents. The visible label is
            // two spans separated by a flex gap, which concatenates to
            // "…~/.claudeMerge" with no space in the accessible name — and below
            // `sm` the lead clause is `display:none`, so the name would shrink to
            // the verb alone on exactly the device with the least context.
            aria-label="Merge this instance's chats into your ~/.claude"
            className="focus-visible:focus-ring flex h-6 items-center gap-1.5 rounded-md pl-2 pr-1.5 text-2xs can-hover:hover:underline"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-[1px] bg-accent-solid" aria-hidden="true" />
            {/*
              Two tiers, resolved in CSS rather than JS. `FleetReadout` resolves
              its channel budget in JS because a hidden channel would make its
              `+N` overflow marker lie; nothing here is a count, so hiding the
              lead clause drops no truth — the button keeps its full sentence in
              `title` and in the accessible name at every width.

              Below `sm` the "existing negative space" this chip was designed for
              does not exist, and the answer is NOT to hide the offer: a phone is
              where Ed actually reads this app, and an offer nobody on a phone can
              see is the discovery surface failing on the device it matters most
              on. So it collapses to the verb — still a visible, accent-coloured,
              tappable control with the same 24px hit target — and the channels
              beside it, which already clip at that width, give up the space.
            */}
            {/* The fact is neutral and the verb is the accent. Painting the
                whole chip accent-coloured made a statement about how the
                instance is arranged read as an alert about it — which is the
                one thing this copy is trying not to do. Measured by painting
                the resolved colours to a canvas and reading the pixels back,
                rather than by parsing tokens — `accent-soft` is a `color-mix`,
                so there is no hex to read. Against the chip's own fill:
                6.83:1 (lead) and 5.16:1 (verb) in dark, 7.62:1 and 6.56:1 in
                light. AA at 11px wants 4.5:1. */}
            <span className="hidden whitespace-nowrap text-fg-muted sm:inline">
              Chats are separate from <span className="font-mono">~/.claude</span>
            </span>
            <span className="whitespace-nowrap font-semibold text-accent">
              Merge<span className="sm:hidden"> chats</span>
            </span>
          </button>
          <button
            type="button"
            data-testid="migration-offer-dismiss"
            onClick={onDismiss}
            aria-label="Hide the transcript migration offer"
            title="Hide this. You can still start the migration from the Config screen."
            className="focus-visible:focus-ring flex h-5 w-5 shrink-0 items-center justify-center rounded text-accent can-hover:hover:bg-accent-solid/15"
          >
            <XIcon width={11} height={11} />
          </button>
        </div>
      )}

      <MigrationDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCompleted={() => setMigrated(true)}
      />

      <Toast
        message={toast}
        onDismiss={() => setToast(null)}
        // Double the 6s default. This one carries an instruction ("it lives on
        // Config now") rather than an outcome, it is the only time that
        // instruction is ever shown, and it offers an action — which `Toast`'s
        // own note says should raise the dwell, because reading an outcome and
        // deciding to act on it are different lengths of time. Nine seconds was
        // measurably too short: the offer had already expired by the time it was
        // reached during QA.
        durationMs={12000}
        action={{
          label: "Open Config",
          onAct: () => {
            setToast(null);
            navigate("/config");
          },
        }}
      />
    </>
  );
}

/**
 * The Config screen's entry point — the durable home the banner's dismissal
 * toast points at.
 *
 * It is here because dismissal has to be recoverable: #882 settled on
 * "dismissible yet findable", and design §10.4 makes Config the place it is
 * found, which is also the only place a `paranoid` instance is offered the
 * migration at all (that profile suppresses the banner deliberately — a
 * permanent offer to undo the posture you chose is nagging).
 *
 * Rendered from `InstanceConfigPage` rather than inside `InstanceConfigForm`,
 * for two reasons: the form is generated from the server's field list, where
 * `claude.transcripts` is a read-only row, and this is an ACTION rather than a
 * field. Keeping it above the form also keeps this PR's diff out of a 1,200-line
 * file that the migration modal's own PR will want to touch.
 */
export function MigrationOfferCard() {
  const { showInConfig } = useMigrationOffer();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [migrated, setMigrated] = useState(false);

  if (!showInConfig) return null;

  return (
    <div className="px-3 pt-3 sm:px-6" data-testid="migration-offer-card">
      {/*
        Hidden once the migration has run — but the DIALOG stays mounted below,
        deliberately. The completion screen is rendered inside it and is the only
        place `preserved[]` and the restart instruction ever appear; unmounting
        the whole card on success would close the results over the user's head at
        the exact moment they need to read them.
      */}
      {!migrated && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-accent-edge bg-accent-soft px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-fg">
              Chats are separate from <span className="font-mono">~/.claude</span>
            </p>
            <p className="mt-0.5 text-xs text-fg-muted">
              This instance keeps its transcripts in each project's own store, so the Claude Code
              CLI does not see them. Merging moves them into your Claude home and switches{" "}
              <span className="font-mono">claude.transcripts</span> to{" "}
              <span className="font-mono">host</span>.
            </p>
          </div>
          <Button variant="primary" size="sm" onClick={() => setDialogOpen(true)}>
            Merge chats…
          </Button>
        </div>
      )}
      <MigrationDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCompleted={() => setMigrated(true)}
      />
    </div>
  );
}
