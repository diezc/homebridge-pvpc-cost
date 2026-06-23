#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  printf 'Usage: %s <ssh-target> <homebridge-container-name> [docker|podman]\n' "$0" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_PATH="${ROOT_DIR}/artifacts/homebridge-pvpc-cost.tgz"
SSH_TARGET="$1"
CONTAINER_NAME="$2"
RUNTIME="${3:-docker}"
REMOTE_ARTIFACT="/tmp/homebridge-pvpc-cost.tgz"

if [[ ! -f "${ARTIFACT_PATH}" ]]; then
  printf 'Package artifact not found at %s\n' "${ARTIFACT_PATH}" >&2
  printf 'Run ./scripts/podman-pack.sh first.\n' >&2
  exit 1
fi

scp "${ARTIFACT_PATH}" "${SSH_TARGET}:${REMOTE_ARTIFACT}"

ssh "${SSH_TARGET}" \
  "set -euo pipefail; \
  if ! ${RUNTIME} ps --format '{{.Names}}' | grep -Fx '${CONTAINER_NAME}' >/dev/null; then \
    echo 'Container ${CONTAINER_NAME} not found in ${RUNTIME} ps output' >&2; exit 1; \
  fi; \
  ${RUNTIME} cp '${REMOTE_ARTIFACT}' '${CONTAINER_NAME}:${REMOTE_ARTIFACT}'; \
  ${RUNTIME} exec '${CONTAINER_NAME}' sh -lc 'npm install -g ${REMOTE_ARTIFACT}'; \
  ${RUNTIME} restart '${CONTAINER_NAME}'; \
  echo 'Installed plugin into ${CONTAINER_NAME} and restarted it.'; \
  echo 'Note: this is a temporary install and will be lost if the stack recreates the container.'"
