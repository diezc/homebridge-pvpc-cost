import { readFileSync } from 'node:fs';

export const PLUGIN_NAME = 'homebridge-pvpc-cost';
export const PLATFORM_NAME = 'PVPCCost';
// Read from package.json (one level up from both src/ and dist/) so HomeKit always reports the published version.
export const PLUGIN_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
export const MADRID_TIME_ZONE = 'Europe/Madrid';
export const PUBLIC_PVPC_URL = 'https://api.esios.ree.es/archives/70/download_json';
export const TOKEN_PVPC_URL = 'https://api.esios.ree.es/indicators/1001';
export const DEFAULT_UPDATE_INTERVAL_MINUTES = 15;
export const DEFAULT_CHEAP_THRESHOLD_EUR_KWH = 0.10;
export const DEFAULT_EXPENSIVE_THRESHOLD_EUR_KWH = 0.15;
export const DEFAULT_ZONE = 'PCB';
export const DEFAULT_EXPOSE_MODE = 'both';
export const CACHE_FILE_NAME = 'pvpc-cost-cache.json';
export const MAX_FETCH_ATTEMPTS = 3;
export const FETCH_RETRY_DELAY_MS = 1500;
export const FETCH_TIMEOUT_MS = 15000;
export const MOCK_DATA_FILE_ENV = 'PVPC_MOCK_DATA_FILE';
