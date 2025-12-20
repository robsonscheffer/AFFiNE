import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { Config, OnEvent } from '../../../base';
import { CopilotProviderFactory } from './factory';
import { GenericOpenAIConfig,GenericOpenAIProvider } from './generic-openai';

/**
 * Manager for multiple GenericOpenAI provider instances.
 *
 * This service handles:
 * - Creating provider instances from array configuration
 * - Registering/unregistering instances with the factory
 * - Handling configuration changes at runtime
 * - Backward compatibility with legacy single-object config
 */
@Injectable()
export class GenericOpenAIProviderManager implements OnModuleInit {
  private readonly logger = new Logger(GenericOpenAIProviderManager.name);
  private readonly instances = new Map<string, GenericOpenAIProvider>();

  @Inject()
  private readonly AFFiNEConfig!: Config;

  @Inject()
  private readonly factory!: CopilotProviderFactory;

  @Inject()
  private readonly moduleRef!: ModuleRef;

  async onModuleInit() {
    await this.setupInstances();
  }

  @OnEvent('config.changed')
  async onConfigChanged(event: Events['config.changed']) {
    if ('copilot' in event.updates) {
      await this.setupInstances();
    }
  }

  @OnEvent('config.init')
  async onConfigInit() {
    await this.setupInstances();
  }

  /**
   * Normalize configuration to handle both legacy single-object
   * and new array formats.
   */
  private normalizeConfig(): GenericOpenAIConfig[] {
    // Cast as unknown to handle both array and legacy object formats
    const raw = this.AFFiNEConfig.copilot?.providers?.genericOpenAI as unknown;

    // No config
    if (!raw) {
      return [];
    }

    // New array format
    if (Array.isArray(raw)) {
      return raw.filter(
        (c): c is GenericOpenAIConfig =>
          !!c && typeof c === 'object' && !!c.name && !!c.apiKey && !!c.baseURL
      );
    }

    // Legacy single-object format (backward compatibility)
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'apiKey' in raw &&
      'baseURL' in raw &&
      (raw as Record<string, unknown>).apiKey &&
      (raw as Record<string, unknown>).baseURL
    ) {
      const legacyConfig = raw as Record<string, unknown>;
      return [
        {
          name: 'default',
          apiKey: legacyConfig.apiKey as string,
          baseURL: legacyConfig.baseURL as string,
          modelIdPrefix: (legacyConfig.modelIdPrefix as string) || undefined,
        },
      ];
    }

    return [];
  }

  /**
   * Setup all GenericOpenAI provider instances from configuration.
   * Handles add/update/remove of instances dynamically.
   */
  private async setupInstances() {
    const configs = this.normalizeConfig();
    const configNames = new Set(configs.map(c => c.name));

    // Unregister removed instances
    for (const [name, instance] of this.instances) {
      if (!configNames.has(name)) {
        this.factory.unregister(instance);
        this.instances.delete(name);
        this.logger.log(`GenericOpenAI instance [${name}] unregistered.`);
      }
    }

    // Register new/update existing instances
    for (const cfg of configs) {
      const existing = this.instances.get(cfg.name);

      if (existing) {
        // Update existing instance
        existing.updateConfig(cfg);
        this.logger.log(`GenericOpenAI instance [${cfg.name}] config updated.`);
      } else {
        // Create new instance using the static factory method
        const newInstance = GenericOpenAIProvider.createInstance(cfg, {
          AFFiNEConfig: this.AFFiNEConfig,
          factory: this.factory,
          moduleRef: this.moduleRef,
        });

        this.instances.set(cfg.name, newInstance);
        this.logger.log(
          `GenericOpenAI instance [${cfg.name}] created with ${newInstance.models.length} models.`
        );
      }
    }

    if (configs.length > 0) {
      this.logger.log(
        `GenericOpenAI manager initialized with ${configs.length} instance(s): ${configs.map(c => c.name).join(', ')}`
      );
    }
  }

  /**
   * Get all active GenericOpenAI provider instances.
   */
  getInstances(): GenericOpenAIProvider[] {
    return Array.from(this.instances.values());
  }

  /**
   * Get a specific instance by name.
   */
  getInstance(name: string): GenericOpenAIProvider | undefined {
    return this.instances.get(name);
  }
}
