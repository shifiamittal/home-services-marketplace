#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

action="${1:-}"
wrangler="${SITES_PROJECT_ROOT}/node_modules/.bin/wrangler"
tsc="${SITES_PROJECT_ROOT}/node_modules/.bin/tsc"
config_file="${SITES_PROJECT_ROOT}/wrangler.jsonc"

if [[ ! -x "${wrangler}" || ! -x "${tsc}" ]]; then
  echo "Cloudflare validation tools are unavailable. Run npm run install:ci first." >&2
  exit 69
fi

build_production() {
  NIVASA_DEPLOY_TARGET=cloudflare-production "${script_dir}/build-verified.sh"
}

case "${action}" in
  build)
    build_production
    ;;
  types)
    (cd "${SITES_PROJECT_ROOT}" && "${wrangler}" types worker-configuration.d.ts --config wrangler.jsonc)
    ;;
  validate)
    (cd "${SITES_PROJECT_ROOT}" && "${wrangler}" types worker-configuration.d.ts --config wrangler.jsonc --check)
    "${tsc}" --noEmit
    ;;
  dry-run)
    build_production
    "${wrangler}" deploy --dry-run --strict --outdir "${SITES_PROJECT_ROOT}/.wrangler/deploy-dry-run"
    ;;
  migrations-list)
    "${wrangler}" d1 migrations list DB --config "${config_file}" --remote
    ;;
  migrations-apply)
    "${wrangler}" d1 migrations apply DB --config "${config_file}" --remote
    ;;
  deploy)
    build_production
    "${wrangler}" deploy --strict
    ;;
  *)
    echo "usage: $0 {build|types|validate|dry-run|migrations-list|migrations-apply|deploy}" >&2
    exit 64
    ;;
esac
