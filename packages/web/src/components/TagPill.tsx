import { Link } from "react-router-dom";

/**
 * A single domain tag rendered as a neutral, clickable pill. Clicking navigates
 * to the /tags/:tag filter view; the link is `relative z-10` and stops click
 * propagation so a tag inside a project card (itself a <Link>) filters by tag
 * without ALSO opening the project.
 */
export function TagPill({ tag, className = "" }: { tag: string; className?: string }) {
  return (
    <Link
      to={`/tags/${encodeURIComponent(tag)}`}
      onClick={(e) => e.stopPropagation()}
      title={`Show projects tagged ${tag}`}
      className={`tag relative z-10 transition-colors hover:bg-paddock-300/70 dark:hover:bg-paddock-700 ${className}`}
    >
      {tag}
    </Link>
  );
}
