import { useOutletContext } from "react-router-dom";
import type { ShellOutletContext } from "../components/AppShell";
import { InstanceConfigForm } from "../components/InstanceConfigForm";
import { CogIcon, MenuIcon } from "../components/icons";

/**
 * Instance-wide Settings screen (issue #385) — a top-level admin surface over
 * the frozen instance config (`paddock.config.yaml`), distinct from the
 * per-project Settings tab.
 *
 * This is now just the PAGE SHELL: the editor itself lives in
 * {@link InstanceConfigForm}, so the ROOT project's Settings tab can render the
 * same thing as one of its two sections (issue #516 Phase 5) instead of
 * duplicating it.
 *
 * On an instance with a root project this route is not reached — `/settings`
 * resolves to the root's Settings tab, which shows the root's own workspace
 * config above this same form.
 */
export function InstanceSettings() {
  const shell = useOutletContext<ShellOutletContext | null>();
  const openNav = shell?.openNav ?? (() => {});

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="pt-safe flex items-center gap-2 border-b border-paddock-200 px-3 pb-2.5 dark:border-paddock-800 sm:px-6 lg:py-4">
        <button
          type="button"
          onClick={openNav}
          aria-label="Open menu"
          className="btn-subtle -ml-1 shrink-0 px-2 py-1.5 lg:hidden"
        >
          <MenuIcon width={20} height={20} />
        </button>
        <CogIcon width={18} height={18} className="shrink-0 text-paddock-400" />
        <h1 className="text-[15px] font-semibold tracking-tight">Settings</h1>
      </header>
      <InstanceConfigForm />
    </div>
  );
}
