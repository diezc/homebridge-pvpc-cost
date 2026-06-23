#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 4 ]]; then
  printf 'Usage: %s <ssh-target> <image-tag> [docker|podman] [remote-workdir]\n' "$0" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_PATH="${ROOT_DIR}/artifacts/homebridge-pvpc-cost.tgz"
SSH_TARGET="$1"
IMAGE_TAG="$2"
RUNTIME="${3:-docker}"
REMOTE_WORKDIR="${4:-/tmp/homebridge-pvpc-cost-build}"

if [[ ! -f "${ARTIFACT_PATH}" ]]; then
  printf 'Package artifact not found at %s\n' "${ARTIFACT_PATH}" >&2
  printf 'Run ./scripts/podman-pack.sh first.\n' >&2
  exit 1
fi

ssh "${SSH_TARGET}" "rm -rf '${REMOTE_WORKDIR}' && mkdir -p '${REMOTE_WORKDIR}'"
scp "${ARTIFACT_PATH}" "${ROOT_DIR}/deploy/portainer/Dockerfile.homebridge-pvpc-cost" "${SSH_TARGET}:${REMOTE_WORKDIR}/"

ssh "${SSH_TARGET}" \
  "set -euo pipefail; \
  cd '${REMOTE_WORKDIR}'; \
  ${RUNTIME} build -t '${IMAGE_TAG}' -f Dockerfile.homebridge-pvpc-cost .; \
  echo 'Built image ${IMAGE_TAG}'; \
  echo 'Update your Portainer stack service image to: ${IMAGE_TAG}'"
