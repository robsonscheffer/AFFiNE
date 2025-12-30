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
    this.logger.log(`🔍 Resolving provider for model: ${modelId}`);

    // Parse provider prefix (enforce provider/model-id format)
    if (!modelId.includes('/')) {
      this.logger.error(
        `❌ Model missing provider prefix: "${modelId}". ` +
          `Expected format: "provider/model-id" (e.g., "openai/gpt-4o", "litellm/llama-3")`
      );
      // For backward compatibility, try legacy matching
      return this.legacyGetProviderByModel(modelId, filter);
    }

    const [providerHint, actualModelId] = modelId.split('/', 2);
    this.logger.debug(
      `  Provider hint: ${providerHint}, Model: ${actualModelId}`
    );

    // Map provider hint to provider type
    const providerType = this.mapProviderHint(providerHint);
    if (!providerType) {
      this.logger.error(
        `❌ Unknown provider: "${providerHint}". ` +
          `Available providers: openai, litellm, gemini, anthropic, fal`
      );
      throw new Error(
        `Unknown provider: "${providerHint}". ` +
          `Available providers: openai, litellm, gemini, anthropic, fal`
      );
    }

    // Get provider
    const provider = this.#providers.get(providerType);
    if (!provider?.configured()) {
      this.logger.error(
        `❌ Provider "${providerHint}" is not configured. ` +
          `Please check your config.json`
      );
      throw new Error(
        `Provider "${providerHint}" is not configured. ` +
          `Please check your config.json`
      );
    }

    // Match model
    const matched = await provider.match({ modelId: actualModelId });
    if (!matched) {
      this.logger.warn(
        `⚠️  Model "${actualModelId}" not found in provider "${providerHint}". ` +
          `This may cause runtime errors.`
      );
      // Don't throw - let provider handle it (explicit error)
    } else {
      this.logger.log(
        `✅ Using provider: ${providerType} for model: ${actualModelId}`
      );
    }

    return provider;
  }

  /**
   * Legacy provider resolution (backward compatibility)
   * Tries to match model without provider prefix
   */
  private async legacyGetProviderByModel(
    modelId: string,
    filter: {
      prefer?: CopilotProviderType;
    } = {}
  ): Promise<CopilotProvider | null> {
    this.logger.debug(`Attempting legacy provider resolution for: ${modelId}`);

    let candidate: CopilotProvider | null = null;
    for (const [type, provider] of this.#providers.entries()) {
      if (filter.prefer && filter.prefer !== type) {
        continue;
      }

      if (await provider.match({ modelId })) {
        candidate = provider;
        this.logger.debug(`Copilot provider candidate found: ${type}`);
      }
    }

    return candidate;
  }

  /**
   * Map provider hint to provider type
   * @param hint - Provider hint from model ID (e.g., "openai", "litellm")
   * @returns Provider type or null if unknown
   */
  private mapProviderHint(hint: string): CopilotProviderType | null {
    const mapping: Record<string, CopilotProviderType> = {
      openai: CopilotProviderType.OpenAI,
      litellm: CopilotProviderType.OpenAI, // Uses OpenAI provider with baseURL
      gemini: CopilotProviderType.Gemini,
      anthropic: CopilotProviderType.Anthropic,
      fal: CopilotProviderType.FAL,
    };
    return mapping[hint.toLowerCase()] || null;
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
}
