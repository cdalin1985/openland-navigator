#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

worker="${SITES_PROJECT_ROOT}/dist/server/index.js"
hosting="${SITES_PROJECT_ROOT}/dist/.openai/hosting.json"

[[ -f "${worker}" ]] || {
  echo "Missing Sites Worker entry: dist/server/index.js" >&2
  exit 66
}
[[ -f "${hosting}" ]] || {
  echo "Missing packaged Sites manifest: dist/.openai/hosting.json" >&2
  exit 66
}

node --input-type=module - "${worker}" "${hosting}" <<'NODE'
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// The Worker runs on Cloudflare, where "cloudflare:*" modules exist; plain Node can't load them.
// vinext 1.x always imports "cloudflare:workers" (for request tracing), so this check stands in
// an empty module for any "cloudflare:" import. It only checks the artifact's shape below.
register(
  "data:text/javascript," +
    encodeURIComponent(
      'export async function resolve(specifier, context, next) {' +
        ' if (specifier.startsWith("cloudflare:")) return { url: "data:text/javascript,export {};", shortCircuit: true };' +
        " return next(specifier, context); }",
    ),
);

const [workerPath, hostingPath] = process.argv.slice(2);
JSON.parse(await readFile(hostingPath, "utf8"));

const workerUrl = pathToFileURL(workerPath);
workerUrl.searchParams.set("sites-validation", `${process.pid}-${Date.now()}`);
const worker = await import(workerUrl.href);
if (!worker.default || typeof worker.default.fetch !== "function") {
  throw new Error("dist/server/index.js must have an ESM default export with fetch(request, env, ctx)");
}
NODE

echo "Validated Sites artifact: ESM Worker default.fetch and hosting manifest are present."
