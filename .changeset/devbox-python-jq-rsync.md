---
"@paddock/server": patch
---

devbox image: add `python3`, `python3-pip`, `python3-venv`, `uv`, `jq` and
`rsync`. Python is the default reach for a ten-line data transform whatever the
surrounding project is written in, and `python3: not found` turned that into
"rewrite it in Node" every time; `jq` and `rsync` were the same gap from the
other end. The rule this follows is **interpreters and small CLI utilities in
the image, libraries in the project** — so no AI/data libraries are baked in;
`uv` is there to make a per-project venv cheap enough that they don't need to
be. `python3-venv` comes along because Debian marks the interpreter
`EXTERNALLY-MANAGED` (PEP 668), so a global `pip install` refuses and a venv is
the supported path. Base is untouched; devbox grows ~124 MB on ~4.9 GB.
