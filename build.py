#!/usr/bin/env python3
"""Concatenate src/ into yt-zhuyin-transcript.user.js.

The whole userscript is one IIFE sharing a single closure, so the build is
ordered concatenation: header.txt, the wrapper, then src/*.js in filename
order. Edit src/, never the generated file.

    python3 build.py            # write the userscript
    python3 build.py --check    # exit 1 if the committed file is stale
"""
import pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"
OUT = ROOT / "yt-zhuyin-transcript.user.js"


def build():
    files = sorted(SRC.glob("*.js"))
    if not files:
        sys.exit(f"no .js files in {SRC}")
    body = "".join(f.read_text(encoding="utf-8") for f in files)
    head = (SRC / "header.txt").read_text(encoding="utf-8")
    return head + "(() => {\n  'use strict';\n\n" + body + "})();", files


text, files = build()

if "--check" in sys.argv:
    if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
        sys.exit(f"{OUT.name} is stale — run: python3 build.py")
    print(f"{OUT.name} is up to date")
else:
    OUT.write_text(text, encoding="utf-8")
    print(f"{OUT.name}: {len(text.encode()):,} bytes from {len(files)} source files")
