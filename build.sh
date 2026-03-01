#!/bin/bash
# Build index.html from parts
cat css.part html.part js.part > index.html
rm -f css.part html.part js.part build.sh
echo "Done building index.html"
