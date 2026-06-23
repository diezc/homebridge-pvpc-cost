#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="${ROOT_DIR}/artifacts"
IMAGE_TAG="${IMAGE_TAG:-homebridge-pvpc-cost-pack}"
CONTAINER_NAME="${IMAGE_TAG//[^a-zA-Z0-9_.-]/-}-extract"
ARTIFACT_NAME="homebridge-pvpc-cost.tgz"

mkdir -p "${ARTIFACT_DIR}"

podman build --target pack -t "${IMAGE_TAG}" "${ROOT_DIR}"
podman rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
podman create --name "${CONTAINER_NAME}" "${IMAGE_TAG}" >/dev/null
trap 'podman rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true' EXIT
podman cp "${CONTAINER_NAME}:/tmp/${ARTIFACT_NAME}" "${ARTIFACT_DIR}/${ARTIFACT_NAME}"

printf 'Created package artifact: %s\n' "${ARTIFACT_DIR}/${ARTIFACT_NAME}"
