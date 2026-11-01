#!/bin/sh
set -eu
ana_collector_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Use the user's tools and, when present, private browser libraries installed for
# this Ubuntu environment. These changes apply to this process only.
PATH="$HOME/.local/bin:$PATH"
export PATH
if [ -d "$HOME/.local/lib/ana-browser" ]; then
    LD_LIBRARY_PATH="$HOME/.local/lib/ana-browser${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    export LD_LIBRARY_PATH
fi
exec node "$ana_collector_dir/cli.mjs" "$@"
