import { Link } from "react-router-dom";
import { tagColor } from "../lib/tagColor";

/**
 * A single domain tag rendered as a colored, clickable pill. The color is a
 * stable function of the tag string (see lib/tagColor). Clicking navigates to
 * the /tags/:tag filter view; the link is `relative z-10` and stops click
 * propagation so a tag inside a project card (itself a <Link>) filters by tag
 * without ALSO opening the project.
 */
export function TagPill({ tag, className = "" }: { tag: string; className?: string }) {
  const color = tagColor(tag);
  return (
    <Link
      to={`/tags/${encodeURIComponent(tag)}`}
      onClick={(e) => e.stopPropagation()}
      title={`Show projects tagged ${tag}`}
      className={`relative z-10 inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-opacity hover:opacity-80 ${color.className} ${className}`}
    >
      {tag}
    </Link>
  );
}
