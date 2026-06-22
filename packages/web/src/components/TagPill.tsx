import { useNavigate } from "react-router-dom";

/**
 * A single domain tag rendered as a neutral, clickable pill. Clicking navigates
 * to the /tags/:tag filter view; it stops click propagation so a tag inside a
 * project card (itself a <Link>) filters by tag without ALSO opening the
 * project.
 *
 * Rendered as a <button> (not a <Link>/<a>) because TagPill is nested inside
 * other links (the sidebar NavLink and the landing-page project card), and
 * nested <a> elements are invalid HTML — browsers reparse them, which can break
 * the surrounding link and this pill's stopPropagation. A button navigating via
 * useNavigate keeps the click-to-filter behavior with valid DOM (issue #22).
 */
export function TagPill({ tag, className = "" }: { tag: string; className?: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        navigate(`/tags/${encodeURIComponent(tag)}`);
      }}
      title={`Show projects tagged ${tag}`}
      className={`tag relative z-10 transition-colors hover:bg-paddock-300/70 dark:hover:bg-paddock-700 ${className}`}
    >
      {tag}
    </button>
  );
}
