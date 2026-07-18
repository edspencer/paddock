---
"@paddock/server": minor
"@paddock/web": minor
---

Files tab: browse subdirectories with nested, deep-linkable URLs (#259)

The Files tab previously listed only top-level files, so anything a project filed
under a subdirectory (e.g. `design/`, `aar/`, `docs/`) was invisible. The listing
now returns one directory level at a time with a per-entry kind (file vs dir), and
the Files tab lets you click into folders. The current directory or file is
carried in a nested `/projects/:slug/files/<path>` URL (deep-linkable and
refresh-safe), with a `..` entry to go up and a path breadcrumb. Directories are
visually distinguished and sort ahead of files. The traversal guard stays central
in `resolveInProject`, and the single-file read path already supported nested
names.
