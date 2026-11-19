# homebridge-pvpc-cost

Homebridge dynamic platform plugin that exposes Spain PVPC electricity pricing to Apple Home using HomeKit-compatible proxy accessories.

## Features

- Fetches official PVPC hourly prices from ESIOS/REE.
- Uses the Homebridge dynamic platform model.
- Caches the last valid price set locally and keeps running through API failures.
- Refreshes at startup, every configured interval, and again after `20:30` in `Europe/Madrid` to capture tomorrow's prices.
- Computes:
  - `currentPrice`
  - `currentBand`
  - `isCheapNow`
  - `isExpensiveNow`
  - `nextCheapStart`
- Exposes automation-friendly HomeKit accessories.
- Supports deterministic offline testing through a mock-data file.

## Installation

Install into an existing Homebridge instance:

```bash
npm install -g homebridge-pvpc-cost
```

Then add the platform to Homebridge.

## Remote Container Deployment

Your production Homebridge is running remotely as a Portainer stack, so the recommended flow is:

1. Package the plugin on this development machine.
2. Either install it temporarily into the running Homebridge container, or build a permanent custom Homebridge image on the production server.
3. Update the Homebridge config and restart or redeploy.

### 1. Build the plugin package locally with Podman

```bash
./scripts/podman-pack.sh
```

This creates:

```bash
artifacts/homebridge-pvpc-cost.tgz
```

Equivalent npm script:

```bash
npm run pack:podman
```

### 2A. Temporary install into a running remote Homebridge container

Good for immediate testing. This install is lost if Portainer recreates the container.

```bash
./scripts/install-remote-homebridge.sh <user@server> <homebridge-container-name> [docker|podman]
```

Example:

```bash
./scripts/install-remote-homebridge.sh admin@homebox homebridge docker
```

What it does:

- copies `artifacts/homebridge-pvpc-cost.tgz` to the server
- copies the package into the running Homebridge container
- runs `npm install -g` inside that container
- restarts the container

### 2B. Permanent deployment for a Portainer stack

Build a custom Homebridge image on the production server, then point your Portainer stack to that image.

Build the remote image:

```bash
./scripts/build-remote-homebridge-image.sh <user@server> <image-tag> [docker|podman] [remote-workdir]
```

Example:

```bash
./scripts/build-remote-homebridge-image.sh admin@homebox local/homebridge-pvpc-cost:0.1.0 docker
```

This uploads:

- `artifacts/homebridge-pvpc-cost.tgz`
- `deploy/portainer/Dockerfile.homebridge-pvpc-cost`

and runs a remote image build.

Then update your Portainer stack so your existing Homebridge service uses the custom image tag.

Template files:

- `deploy/portainer/Dockerfile.homebridge-pvpc-cost`
- `deploy/portainer/stack.example.yml`

In your real stack, keep your current volumes, ports, labels, and networks, and only replace the Homebridge service image with your custom image.

## Homebridge Config Example

```json
{
  "platforms": [
    {
      "platform": "PVPCCost",
      "name": "PVPC Cost",
      "zone": "PCB",
      "updateIntervalMinutes": 15,
      "cheapThresholdEurKwh": 0.10,
      "expensiveThresholdEurKwh": 0.15,
      "exposeMode": "both"
    }
  ]
}
```

## Zone Options

- `PCB`: public Peninsula/Balearic/Canary tariff feed.
- `CYM`: public Ceuta/Melilla tariff feed.
- `PENINSULA`
- `CANARIAS`
- `BALEARES`
- `CEUTA`
- `MELILLA`

Exact geographic zones require an ESIOS token. Without a token, the plugin falls back to the nearest public tariff feed:

- `PENINSULA`, `CANARIAS`, `BALEARES` -> `PCB`
- `CEUTA`, `MELILLA` -> `CYM`

Hourly scheduling follows the official REE/PVPC publication clock in `Europe/Madrid`, which is how the public feed is published.

## ESIOS Token

Optional. You can provide it in config or via environment variable:

```bash
export ESIOS_API_TOKEN="your-token"
```

Config value wins if both are set.

## Docker

This repository includes a Docker image that runs Homebridge with the plugin installed.

If you already have a production Homebridge stack, the remote deployment scripts above are usually a better fit than running a second Homebridge container from this repo directly.

### docker-compose example

```yaml
services:
  homebridge-pvpc-cost:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    environment:
      TZ: Europe/Madrid
      ESIOS_API_TOKEN: ${ESIOS_API_TOKEN:-}
    ports:
      - "8581:8581"
    volumes:
      - ./homebridge-data:/homebridge
```

After the container starts, configure the platform in the Homebridge UI or `config.json` stored in the mounted `/homebridge` volume.

## Mock Data Mode

For deterministic testing or offline development, set `PVPC_MOCK_DATA_FILE` to a JSON file containing UTC hourly keys and normalized `EUR/kWh` values.

Example:

```bash
export PVPC_MOCK_DATA_FILE="$(pwd)/test/fixtures/mock-pvpc-data.json"
```

Shape:

```json
{
  "source": "mock",
  "resolvedZoneLabel": "PCB",
  "fetchedAt": "2026-06-22T08:00:00.000Z",
  "hourlyPrices": {
    "2026-06-22T08:00:00.000Z": 0.18,
    "2026-06-22T09:00:00.000Z": 0.16
  }
}
```

This mode bypasses live ESIOS requests and is primarily intended for integration tests and local validation.

## HomeKit Mapping Limitations

Apple Home does not support a generic electricity price sensor. This plugin uses HomeKit-supported proxies instead:

- `PVPC Current Price`: `LightSensor`
  - value is mapped as `lux = c€/kWh`
  - example: `12.34 lux` means `12.34 c€/kWh`
- `PVPC Cheap Now`: `ContactSensor`
- `PVPC Expensive Now`: `ContactSensor`
- `PVPC Data Stale`: `ContactSensor`
- Optional band indicators:
  - `PVPC Cheap`
  - `PVPC Normal`
  - `PVPC Expensive`
  - exposed as status `Switch` accessories

The light sensor mapping is a workaround so the Home app can display a numeric value.

## Accessory Behavior

- `Cheap Now`: closed means the current hour is cheap.
- `Expensive Now`: closed means the current hour is expensive.
- `Data Stale`: closed means the cached data is stale or the current hour is missing.
- `Cheap`, `Normal`, `Expensive` switches mirror the active price band and ignore manual writes.

The boolean accessories use a contact sensor because Apple Home exposes contact changes as automation triggers more reliably than arbitrary stateful metadata.

## Sample Apple Home Automations

### Run something when power is cheap

- Trigger: `PVPC Cheap Now` changes to closed.
- Action: turn on a smart plug.

### Stop something when power is expensive

- Trigger: `PVPC Expensive Now` changes to closed.
- Action: turn off a smart plug.

## Scripts

- `npm run build`
- `npm run lint`
- `npm run test`
- `npm run smoke`
- `npm run pack:podman`
- `npm run pack:dryrun`

## Error Handling

- Retries failed requests up to 3 times with backoff.
- Keeps last valid data in local cache.
- Marks `PVPC Data Stale` closed when data ages out or the current hour is missing.
- Logs important failures and stale transitions without repeating the same warning every poll.

## Notes

- Internal price normalization is always `EUR/kWh`.
- Public ESIOS data works without a token for `PCB` and `CYM`.
- Tomorrow prices are fetched after `20:30` Madrid time when available from ESIOS.
- Internally, hourly prices are stored using UTC hour keys so DST transition days keep all official hours without collisions.
- The package includes `exports`, `types`, a `LICENSE`, dry-run pack validation, and a Homebridge startup smoke test for better publish readiness.
- `scripts/install-remote-homebridge.sh` is for temporary remote installs into a running Homebridge container.
- `scripts/build-remote-homebridge-image.sh` plus `deploy/portainer/Dockerfile.homebridge-pvpc-cost` is the recommended permanent path for a Portainer-managed stack.
