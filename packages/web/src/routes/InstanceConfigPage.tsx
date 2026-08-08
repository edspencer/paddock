import { useOutletContext } from "react-router-dom";
import type { ShellOutletContext } from "../components/AppShell";
import { InstanceConfigForm } from "../components/InstanceConfigForm";
import { CogIcon, MenuIcon } from "../components/icons";

/**
 * The instance **Config** screen (issue #385) — a top-level admin surface over
 * the frozen instance config (`paddock.config.yaml`).
 *
 * Named for the file it writes, which is the point of the split: this is not
 * *settings*. A workspace's Settings tab edits its `project.yaml` and the change
 * is hot-applied by re-registering the agent. This edits `paddock.config.yaml`,
 * which is resolved once at boot and frozen, so every save here is
 * restart-required. Stacking two surfaces with different lifecycles — and two
 * save bars — in one tab is exactly what v0.51.0 did, and it read as one page
 * rendered inside another.
 *
 * So they are two URLs now: `/settings` is the ROOT workspace's Settings tab,
 * identical to any project's, and `/config` is this. The page is only the SHELL
 * — the editor is {@link InstanceConfigForm}, kept separate because it is a
 * fragment designed to slot into a flex column.
 */
export function InstanceConfigPage() {
  const shell = useOutletContext<ShellOutletContext | null>();
  const openNav = shell?.openNav ?? (() => {});

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="pt-safe flex items-center gap-2 border-b border-edge px-3 pb-2.5 sm:px-6 lg:py-4">
        <button
          type="button"
          onClick={openNav}
          aria-label="Open menu"
          className="btn-subtle -ml-1 shrink-0 px-2 py-1.5 lg:hidden"
        >
          <MenuIcon width={20} height={20} />
        </button>
        <CogIcon width={18} height={18} className="shrink-0 text-fg-subtle" />
        <h1 className="text-md font-semibold tracking-tight">Config</h1>
      </header>
      <InstanceConfigForm />
    </div>
  );
}
