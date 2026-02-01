import { Injectable, Logger } from '@nestjs/common';

import { ServerFeature, ServerService } from '../../../core';
import type { CopilotProvider } from './provider';
import { CopilotProviderType, ModelFullConditions } from './types';

@Injectable()
export class CopilotProviderFactory {
  constructor(private readonly server: ServerService) {}

  private readonly logger = new Logger(CopilotProviderFactory.name);

  readonly #providers = new Map<CopilotProviderType, CopilotProvider>();

  async getProvider(
    cond: ModelFullConditions,
    filter: {
      prefer?: CopilotProviderType;
    } = {}
  ): Promise<CopilotProvider | null> {
    this.logger.debug(
      `Resolving copilot provider for output type: ${cond.outputType}`
    );
    let candidate: CopilotProvider | null = null;
    for (const [type, provider] of this.#providers.entries()) {
      if (filter.prefer && filter.prefer !== type) {
        continue;
      }

      const isMatched = await provider.match(cond);

      if (isMatched) {
        candidate = provider;
        this.logger.debug(`Copilot provider candidate found: ${type}`);
        break;
      }
    }

    return candidate;
  }

  async getProviderByModel(
    modelId: string,
    filter: {
      prefer?: CopilotProviderType;
    } = {}
  ): Promise<CopilotProvider | null> {
    this.logger.debug(`Resolving copilot provider for model: ${modelId}`);

    let candidate: CopilotProvider | null = null;
    for (const [type, provider] of this.#providers.entries()) {
      if (filter.prefer && filter.prefer !== type) {
        continue;
      }

      this.logger.debug(`Checking provider ${type} for match...`);
      const isMatched = await provider.match({ modelId });
      this.logger.debug(`Provider ${type} match result: ${isMatched}`);

      if (isMatched) {
        candidate = provider;
        this.logger.debug(`Copilot provider candidate found: ${type}`);
        break;
      }
    }

    if (!candidate) {
      this.logger.warn(`No copilot provider found for model: ${modelId}`);
    }

    return candidate;
  }

  register(provider: CopilotProvider) {
    this.#providers.set(provider.type, provider);
    this.logger.log(`Copilot provider [${provider.type}] registered.`);
    this.server.enableFeature(ServerFeature.Copilot);
  }

  unregister(provider: CopilotProvider) {
    this.#providers.delete(provider.type);
    this.logger.log(`Copilot provider [${provider.type}] unregistered.`);
    if (this.#providers.size === 0) {
      this.server.disableFeature(ServerFeature.Copilot);
    }
  }

  /**
   * Get all available models from all registered providers.
   * Only includes dynamically loaded online models for enterprise-grade single source of truth.
   */
  getAvailableModels(): string[] {
    const models: string[] = [];
    for (const [, provider] of this.#providers.entries()) {
      if (provider.configured()) {
        // Only add dynamically loaded models from onlineModelList
        // Do NOT add hardcoded models - use single source of truth
        models.push(...provider.onlineModelList);
      }
    }
    // Deduplicate
    return [...new Set(models)];
  }
}
