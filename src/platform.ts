import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  Service as HAPService,
} from 'homebridge';

import {
  DEFAULT_CHEAP_THRESHOLD_EUR_KWH,
  DEFAULT_EXPENSIVE_THRESHOLD_EUR_KWH,
  DEFAULT_EXPOSE_MODE,
  DEFAULT_UPDATE_INTERVAL_MINUTES,
  DEFAULT_ZONE,
  MOCK_DATA_FILE_ENV,
  PLATFORM_NAME,
  PLUGIN_NAME,
  PLUGIN_VERSION,
} from './settings.js';
import { computeDerivedState } from './pvpc-state.js';
import { mergeHourlyPrices, PVPCClient } from './pvpc-client.js';
import { getTomorrowRefreshDelayMs, getUtcHourKey } from './time.js';
import type {
  AccessoryKind,
  Band,
  DerivedState,
  ExposeMode,
  FetchPricesResult,
  PVPCCostPlatformConfig,
  ResolvedConfig,
  Zone,
} from './types.js';

interface AccessoryContext {
  kind: AccessoryKind;
}

export class PVPCCostPlatform implements DynamicPlatformPlugin {
  public readonly Service: API['hap']['Service'];
  public readonly Characteristic: API['hap']['Characteristic'];
  public readonly accessories = new Map<string, PlatformAccessory<AccessoryContext>>();

  private readonly resolvedConfig: ResolvedConfig;
  private readonly cacheDirectory: string;
  private readonly client: PVPCClient;

  private refreshTimer?: NodeJS.Timeout;
  private tomorrowRefreshTimer?: NodeJS.Timeout;
  private hourlyPrices: Record<string, number> = {};
  private derivedState?: DerivedState;
  private lastSuccessfulFetchAt?: Date;
  private lastSourceLabel = 'unknown';
  private staleWarningLogged = false;
  private fetchErrorLogged = false;
  private tomorrowErrorLogged = false;
  private lastStateSummary?: string;
  private refreshInFlight?: Promise<void>;
  private refreshRerunReason?: string;

  constructor(
    public readonly log: Logging,
    config: PVPCCostPlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.resolvedConfig = resolveConfig(config);
    this.cacheDirectory = path.join(this.api.user.storagePath(), 'homebridge-pvpc-cost');
    this.client = new PVPCClient(
      this.cacheDirectory,
      makeCacheKey(this.resolvedConfig.name, this.resolvedConfig.zone),
      this.resolvedConfig.zone,
      this.resolvedConfig.esiosApiToken,
      this.resolvedConfig.mockDataFile,
    );

    this.log.info(`Initializing ${this.resolvedConfig.name} for zone ${this.resolvedConfig.zone}`);
    if (this.client.isMockMode()) {
      void this.logMockMode();
    }
    if (this.client.usesApproximatePublicZone()) {
      this.log.info(
        `Zone ${this.resolvedConfig.zone} is using public ${this.client.getResolvedZoneLabel()} pricing; set ESIOS_API_TOKEN for exact geographic prices.`,
      );
    }

    this.api.on('didFinishLaunching', () => {
      void this.initialize();
    });
  }

  configureAccessory(accessory: PlatformAccessory<AccessoryContext>): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  private async initialize(): Promise<void> {
    await mkdir(this.cacheDirectory, { recursive: true });

    const cached = await this.client.loadCache();
    if (cached !== null) {
      this.hourlyPrices = cached.hourlyPrices;
      this.lastSuccessfulFetchAt = new Date(cached.fetchedAt);
      this.lastSourceLabel = cached.source;
      this.log.info(`Loaded cached PVPC data from ${cached.fetchedAt}`);
    }

    this.syncAccessories();
    this.updateCharacteristics();

    await this.refreshData('startup');

    this.refreshTimer = setInterval(() => {
      void this.refreshData('interval');
    }, this.resolvedConfig.updateIntervalMinutes * 60000);

    this.scheduleTomorrowRefresh();
  }

  private async logMockMode(): Promise<void> {
    const mockPath = await this.client.getMockDataFilePath();
    this.log.warn(`Using mock PVPC data from ${mockPath ?? this.resolvedConfig.mockDataFile}`);
  }

  private scheduleTomorrowRefresh(): void {
    if (this.tomorrowRefreshTimer !== undefined) {
      clearTimeout(this.tomorrowRefreshTimer);
    }

    const delayMs = getTomorrowRefreshDelayMs(new Date());
    this.tomorrowRefreshTimer = setTimeout(() => {
      void this.refreshData('evening-refresh');
      this.scheduleTomorrowRefresh();
    }, delayMs);
  }

  /**
   * Runs at most one refresh at a time. A refresh requested while another is in flight
   * is coalesced into a single follow-up run once the current one finishes.
   */
  private refreshData(reason: string): Promise<void> {
    if (this.refreshInFlight !== undefined) {
      this.log.debug(`PVPC refresh (${reason}) requested while another is running; queued`);
      this.refreshRerunReason = reason;
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.runRefresh(reason).finally(() => {
      this.refreshInFlight = undefined;
      const rerunReason = this.refreshRerunReason;
      this.refreshRerunReason = undefined;
      if (rerunReason !== undefined) {
        void this.refreshData(rerunReason);
      }
    });
    return this.refreshInFlight;
  }

  private async runRefresh(reason: string): Promise<void> {
    try {
      const result = await this.client.fetchLatest(new Date());
      this.applyFetchResult(result, reason);
      await this.client.saveCache({ ...result, hourlyPrices: this.hourlyPrices });
      this.fetchErrorLogged = false;
    } catch (error) {
      if (!this.fetchErrorLogged) {
        const message = error instanceof Error ? error.message : 'Unknown refresh error';
        this.log.warn(`PVPC refresh failed during ${reason}: ${message}`);
        this.fetchErrorLogged = true;
      }
      this.updateCharacteristics();
    }
  }

  private applyFetchResult(result: FetchPricesResult, reason: string): void {
    this.hourlyPrices = mergeHourlyPrices(this.hourlyPrices, result.hourlyPrices);
    this.logTomorrowResult(result.tomorrowError, reason);
    this.lastSuccessfulFetchAt = new Date(result.fetchedAt);
    this.lastSourceLabel = `${result.source} (${result.resolvedZoneLabel})`;
    this.updateCharacteristics();

    const currentPrice = this.hourlyPrices[getUtcHourKey(new Date())];
    const currentPriceLabel = currentPrice === undefined ? 'n/a' : `${(currentPrice * 100).toFixed(2)} c€/kWh`;
    if (reason === 'startup') {
      this.log.info(`PVPC data loaded from ${this.lastSourceLabel}; current price ${currentPriceLabel}`);
    } else {
      this.log.debug(`PVPC data refreshed from ${this.lastSourceLabel}; current price ${currentPriceLabel}`);
    }
  }

  private logTomorrowResult(tomorrowError: string | undefined, reason: string): void {
    if (tomorrowError === undefined) {
      this.tomorrowErrorLogged = false;
      return;
    }

    if (!this.tomorrowErrorLogged) {
      this.log.info(`Tomorrow's PVPC prices not available yet during ${reason}: ${tomorrowError}`);
      this.tomorrowErrorLogged = true;
    }
  }

  private syncAccessories(): void {
    const desiredKinds = getDesiredAccessoryKinds(this.resolvedConfig.exposeMode);
    const activeUuids = new Set<string>();

    for (const kind of desiredKinds) {
      const accessory = this.ensureAccessory(kind);
      activeUuids.add(accessory.UUID);
    }

    this.log.debug(`Accessory set active for exposeMode=${this.resolvedConfig.exposeMode}: ${desiredKinds.join(', ')}`);

    const staleAccessories = [...this.accessories.values()].filter(accessory => !activeUuids.has(accessory.UUID));
    if (staleAccessories.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
      for (const accessory of staleAccessories) {
        this.accessories.delete(accessory.UUID);
      }
      this.log.info(`Removed ${staleAccessories.length} accessories no longer needed for exposeMode=${this.resolvedConfig.exposeMode}`);
    }
  }

  private ensureAccessory(kind: AccessoryKind): PlatformAccessory<AccessoryContext> {
    const uuid = this.api.hap.uuid.generate(`${this.resolvedConfig.name}:${this.resolvedConfig.zone}:${kind}`);
    const existingAccessory = this.accessories.get(uuid);

    if (existingAccessory !== undefined) {
      existingAccessory.displayName = getAccessoryDisplayName(this.resolvedConfig.name, kind);
      existingAccessory.context.kind = kind;
      this.configureAccessoryInformation(existingAccessory);
      this.configureService(existingAccessory, kind);
      return existingAccessory;
    }

    const displayName = getAccessoryDisplayName(this.resolvedConfig.name, kind);
    const accessory = new this.api.platformAccessory<AccessoryContext>(displayName, uuid);
    accessory.context.kind = kind;
    this.configureAccessoryInformation(accessory);
    this.configureService(accessory, kind);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.set(uuid, accessory);
    this.log.debug(`Registered accessory ${displayName}`);
    return accessory;
  }

  private configureAccessoryInformation(accessory: PlatformAccessory<AccessoryContext>): void {
    const informationService = accessory.getService(this.Service.AccessoryInformation);
    if (informationService === undefined) {
      return;
    }

    informationService
      .setCharacteristic(this.Characteristic.Manufacturer, 'OpenCode')
      .setCharacteristic(this.Characteristic.Model, getAccessoryModel(accessory.context.kind))
      .setCharacteristic(this.Characteristic.SerialNumber, `${this.resolvedConfig.zone}-${accessory.context.kind}`)
      .setCharacteristic(this.Characteristic.FirmwareRevision, PLUGIN_VERSION)
      .setCharacteristic(this.Characteristic.SoftwareRevision, PLUGIN_VERSION)
      .setCharacteristic(this.Characteristic.HardwareRevision, '1');
  }

  private configureService(accessory: PlatformAccessory<AccessoryContext>, kind: AccessoryKind): void {
    const name = getAccessoryDisplayName(this.resolvedConfig.name, kind);
    const service = this.getOrCreatePrimaryService(accessory, kind, name);
    service.setCharacteristic(this.Characteristic.Name, name);

    if (kind === 'current-price') {
      service.getCharacteristic(this.Characteristic.CurrentAmbientLightLevel)
        .setProps({
          minValue: 0.0001,
          minStep: 0.01,
          maxValue: 100000,
          description: `${name} (c€/kWh via lux)`,
        })
        .onGet(() => this.getCurrentPriceLuxValue());
      return;
    }

    if (kind === 'cheap-now' || kind === 'expensive-now' || kind === 'data-stale') {
      service.getCharacteristic(this.Characteristic.ContactSensorState)
        .setProps({ description: name })
        .onGet(() => this.getContactState(kind));
      return;
    }

    service.getCharacteristic(this.Characteristic.On)
      .setProps({ description: name })
      .onGet(() => this.getBandSwitchState(kind))
      .onSet(() => {
        this.log.debug(`Ignoring write to status switch ${name}`);
        this.updateCharacteristics();
      });
  }

  private getOrCreatePrimaryService(
    accessory: PlatformAccessory<AccessoryContext>,
    kind: AccessoryKind,
    name: string,
  ): HAPService {
    const serviceType = getServiceType(kind, this.Service);
    const existing = accessory.getServiceById(serviceType, kind) ?? accessory.getService(serviceType);
    if (existing !== undefined) {
      return existing;
    }

    return accessory.addService(serviceType, name, kind);
  }

  private updateCharacteristics(): void {
    this.derivedState = computeDerivedState(
      this.hourlyPrices,
      new Date(),
      this.resolvedConfig.cheapThresholdEurKwh,
      this.resolvedConfig.expensiveThresholdEurKwh,
      this.resolvedConfig.updateIntervalMinutes,
      this.lastSuccessfulFetchAt,
    );

    for (const accessory of this.accessories.values()) {
      const service = accessory.getServiceById(
        getServiceType(accessory.context.kind, this.Service),
        accessory.context.kind,
      ) ?? accessory.getService(getServiceType(accessory.context.kind, this.Service));
      if (service === undefined) {
        continue;
      }

      switch (accessory.context.kind) {
        case 'current-price':
          service.updateCharacteristic(
            this.Characteristic.CurrentAmbientLightLevel,
            this.getCurrentPriceLuxValue(),
          );
          break;
        case 'cheap-now':
        case 'expensive-now':
        case 'data-stale':
          service.updateCharacteristic(
            this.Characteristic.ContactSensorState,
            this.getContactState(accessory.context.kind),
          );
          break;
        case 'band-cheap':
        case 'band-normal':
        case 'band-expensive':
          service.updateCharacteristic(this.Characteristic.On, this.getBandSwitchState(accessory.context.kind));
          break;
      }
    }

    if (this.derivedState.stale && !this.staleWarningLogged) {
      this.log.warn(`PVPC data is stale (${this.derivedState.staleReason ?? 'unknown reason'})`);
      this.staleWarningLogged = true;
    }

    if (!this.derivedState.stale) {
      if (this.staleWarningLogged) {
        this.log.info('PVPC data is fresh again');
      }
      this.staleWarningLogged = false;
    }

    this.logStateSummary();
  }

  private getCurrentPriceLuxValue(): number {
    const currentPriceCents = this.derivedState?.currentPriceCentsKwh;
    return currentPriceCents === null || currentPriceCents === undefined
      ? 0.0001
      : Math.max(0.0001, currentPriceCents);
  }

  private getContactState(kind: 'cheap-now' | 'expensive-now' | 'data-stale'): number {
    if (this.derivedState === undefined) {
      return this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
    }

    const active = kind === 'cheap-now'
      ? this.derivedState.isCheapNow
      : kind === 'expensive-now'
        ? this.derivedState.isExpensiveNow
        : this.derivedState.stale;

    return active
      ? this.Characteristic.ContactSensorState.CONTACT_DETECTED
      : this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  private getBandSwitchState(kind: 'band-cheap' | 'band-normal' | 'band-expensive'): boolean {
    if (this.derivedState?.currentBand === undefined || this.derivedState.currentBand === null) {
      return false;
    }

    const band = kind.replace('band-', '') as Band;
    return this.derivedState.currentBand === band;
  }

  private logStateSummary(): void {
    if (this.derivedState === undefined) {
      return;
    }

    const summary = [
      this.derivedState.currentPriceCentsKwh === null
        ? 'price=n/a'
        : `price=${this.derivedState.currentPriceCentsKwh.toFixed(2)}c`,
      `band=${this.derivedState.currentBand ?? 'unknown'}`,
      `cheap=${this.derivedState.isCheapNow}`,
      `expensive=${this.derivedState.isExpensiveNow}`,
      `nextCheap=${this.derivedState.nextCheapStart ?? 'none'}`,
      `stale=${this.derivedState.stale}`,
    ].join(' ');

    if (summary !== this.lastStateSummary) {
      this.log.info(`PVPC state ${summary}`);
      this.lastStateSummary = summary;
    }
  }
}

function resolveConfig(config: PVPCCostPlatformConfig): ResolvedConfig {
  const updateIntervalMinutes = clampInteger(config.updateIntervalMinutes, DEFAULT_UPDATE_INTERVAL_MINUTES, 5, 180);
  const [cheapThresholdEurKwh, expensiveThresholdEurKwh] = [
    config.cheapThresholdEurKwh ?? DEFAULT_CHEAP_THRESHOLD_EUR_KWH,
    config.expensiveThresholdEurKwh ?? DEFAULT_EXPENSIVE_THRESHOLD_EUR_KWH,
  ].sort((left, right) => left - right);
  const name = typeof config.name === 'string' && config.name.trim().length > 0 ? config.name.trim() : 'PVPC Cost';
  const zone = normalizeZone(config.zone);
  const exposeMode = normalizeExposeMode(config.exposeMode);
  const token = normalizeToken(config.esiosApiToken ?? process.env.ESIOS_API_TOKEN);
  const mockDataFile = normalizeToken(process.env[MOCK_DATA_FILE_ENV]);

  return {
    name,
    zone,
    updateIntervalMinutes,
    cheapThresholdEurKwh,
    expensiveThresholdEurKwh,
    exposeMode,
    esiosApiToken: token,
    mockDataFile,
    priceProxyType: 'light',
  };
}

function normalizeToken(token: string | undefined): string | undefined {
  const trimmed = token?.trim();
  return trimmed === '' ? undefined : trimmed;
}

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = Number.isFinite(value) ? Math.round(value as number) : fallback;
  return Math.min(maximum, Math.max(minimum, candidate));
}

function normalizeZone(zone: string | undefined): Zone {
  const allowedZones = new Set<Zone>(['PCB', 'CYM', 'PENINSULA', 'CANARIAS', 'BALEARES', 'CEUTA', 'MELILLA']);
  return allowedZones.has(zone as Zone) ? zone as Zone : DEFAULT_ZONE;
}

function normalizeExposeMode(exposeMode: string | undefined): ExposeMode {
  const allowedModes = new Set<ExposeMode>(['switches', 'sensors', 'both']);
  return allowedModes.has(exposeMode as ExposeMode) ? exposeMode as ExposeMode : DEFAULT_EXPOSE_MODE;
}

function getDesiredAccessoryKinds(exposeMode: ExposeMode): AccessoryKind[] {
  const sensors: AccessoryKind[] = ['current-price', 'cheap-now', 'expensive-now', 'data-stale'];
  const switches: AccessoryKind[] = ['band-cheap', 'band-normal', 'band-expensive'];

  if (exposeMode === 'sensors') {
    return sensors;
  }

  if (exposeMode === 'switches') {
    return switches;
  }

  return [...sensors, ...switches];
}

function getAccessoryDisplayName(baseName: string, kind: AccessoryKind): string {
  switch (kind) {
    case 'current-price':
      return `${baseName} Current Price`;
    case 'cheap-now':
      return `${baseName} Cheap Now`;
    case 'expensive-now':
      return `${baseName} Expensive Now`;
    case 'data-stale':
      return `${baseName} Data Stale`;
    case 'band-cheap':
      return `${baseName} Cheap`;
    case 'band-normal':
      return `${baseName} Normal`;
    case 'band-expensive':
      return `${baseName} Expensive`;
  }
}

function getServiceType(kind: AccessoryKind, ServiceCtor: API['hap']['Service']) {
  switch (kind) {
    case 'current-price':
      return ServiceCtor.LightSensor;
    case 'cheap-now':
    case 'expensive-now':
    case 'data-stale':
      return ServiceCtor.ContactSensor;
    case 'band-cheap':
    case 'band-normal':
    case 'band-expensive':
      return ServiceCtor.Switch;
  }
}

function getAccessoryModel(kind: AccessoryKind): string {
  switch (kind) {
    case 'current-price':
      return 'PVPC Current Price Sensor';
    case 'cheap-now':
      return 'PVPC Cheap State Sensor';
    case 'expensive-now':
      return 'PVPC Expensive State Sensor';
    case 'data-stale':
      return 'PVPC Data Health Sensor';
    case 'band-cheap':
      return 'PVPC Cheap Band Switch';
    case 'band-normal':
      return 'PVPC Normal Band Switch';
    case 'band-expensive':
      return 'PVPC Expensive Band Switch';
  }
}

function makeCacheKey(name: string, zone: string): string {
  return `${name}-${zone}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
