import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { AISDKError, generateText,stepCountIs, streamText } from 'ai';
import { CoreAssistantMessage, CoreUserMessage } from 'ai';

import {
  CopilotProviderSideError,
  metrics,
  UserFriendlyError,
} from '../../../base';
import { CopilotProvider } from './provider';
import {
  CopilotChatOptions,
  CopilotProviderModel,
  CopilotProviderType,
  ModelConditions,
  ModelInputType,
  ModelOutputType,
  PromptMessage,
  StreamObject,
} from './types';
import {
  chatToGPTMessage,
  CitationParser,
  StreamObjectParser,
  TextStreamParser,
} from './utils';

// Config type for a single GenericOpenAI instance
export type GenericOpenAIConfig = {
  name: string; // Unique instance identifier
  apiKey: string;
  baseURL?: string;
  modelIdPrefix?: string;
  priority?: number; // Lower = higher priority
};

export class GenericOpenAIProvider extends CopilotProvider<GenericOpenAIConfig> {
  readonly type = CopilotProviderType.GenericOpenAI;

  models: CopilotProviderModel[] = [];

  #instance!: ReturnType<typeof createOpenAICompatible>;

  // Instance-specific config (injected by manager)
  private _instanceConfig?: GenericOpenAIConfig;

  /**
   * Static factory method to create a new standalone instance.
   * This is used by GenericOpenAIProviderManager to create multiple instances.
   */
  static createInstance(
    config: GenericOpenAIConfig,
    deps: {
      AFFiNEConfig: CopilotProvider['AFFiNEConfig'];
      factory: CopilotProvider['factory'];
      moduleRef: CopilotProvider['moduleRef'];
    }
  ): GenericOpenAIProvider {
    const instance = new GenericOpenAIProvider();
    // Manually inject dependencies that would normally come from DI
    Object.assign(instance, {
      AFFiNEConfig: deps.AFFiNEConfig,
      factory: deps.factory,
      moduleRef: deps.moduleRef,
    });
    // Use updateConfig which handles both config setting and setup
    instance.updateConfig(config);
    return instance;
  }

  /**
   * Composite identifier for factory registration.
   * Format: "genericOpenAI:instanceName"
   */
  get instanceId(): string {
    return `${this.type}:${this._instanceConfig?.name || 'default'}`;
  }

  /**
   * Instance name for display/logging
   */
  get instanceName(): string {
    return this._instanceConfig?.name || 'default';
  }

  /**
   * Override config getter to use instance-specific config when available
   */
  override get config(): GenericOpenAIConfig {
    if (this._instanceConfig) {
      return this._instanceConfig;
    }
    // Fallback to legacy single-instance config (backward compatibility)
    const legacyConfig = this.AFFiNEConfig?.copilot?.providers?.[
      this.type
    ] as unknown;
    if (
      legacyConfig &&
      typeof legacyConfig === 'object' &&
      !Array.isArray(legacyConfig) &&
      'apiKey' in legacyConfig &&
      'baseURL' in legacyConfig
    ) {
      const legacy = legacyConfig as Record<string, unknown>;
      return {
        name: 'default',
        apiKey: legacy.apiKey as string,
        baseURL: legacy.baseURL as string,
        modelIdPrefix: (legacy.modelIdPrefix as string) || undefined,
      };
    }
    return { name: 'default', apiKey: '', baseURL: '' };
  }

  /**
   * Update instance configuration (called by manager)
   */
  updateConfig(config: GenericOpenAIConfig) {
    this._instanceConfig = config;
    this.setupInstance();
  }

  configured(): boolean {
    return !!this.config.apiKey && !!this.config.baseURL;
  }

  protected override setup() {
    // For multi-instance mode, setup is handled by updateConfig
    // For legacy single-instance mode, call setupInstance directly
    if (!this._instanceConfig) {
      const legacyConfig = this.AFFiNEConfig?.copilot?.providers?.[
        this.type
      ] as unknown;
      if (
        legacyConfig &&
        typeof legacyConfig === 'object' &&
        !Array.isArray(legacyConfig) &&
        'apiKey' in legacyConfig &&
        'baseURL' in legacyConfig
      ) {
        const legacy = legacyConfig as Record<string, unknown>;
        if (legacy.apiKey && legacy.baseURL) {
          this._instanceConfig = {
            name: 'default',
            apiKey: legacy.apiKey as string,
            baseURL: legacy.baseURL as string,
            modelIdPrefix: (legacy.modelIdPrefix as string) || undefined,
          };
          this.setupInstance();
        }
      }
    }
  }

  /**
   * Internal setup for the OpenAI-compatible instance
   */
  private setupInstance() {
    if (this.configured()) {
      this.#instance = createOpenAICompatible({
        name: `genericOpenAI-${this.instanceName}`,
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL!,
      });
      // Register with factory if not already registered
      if (!this.factory) return;
      this.factory.register(this);
      // Refresh models
      this.refreshOnlineModels().catch(e =>
        this.logger.error(`Failed to refresh models for ${this.instanceId}`, e)
      );
    } else {
      this.factory?.unregister(this);
    }
  }

  private handleError(e: any, _model: string) {
    if (e instanceof UserFriendlyError) {
      return e;
    } else if (e instanceof AISDKError) {
      return new CopilotProviderSideError({
        provider: this.type,
        kind: e.name || 'unknown',
        message: e.message,
      });
    } else {
      return new CopilotProviderSideError({
        provider: this.type,
        kind: 'unexpected_response',
        message: e?.message || 'Unexpected response',
      });
    }
  }

  override async refreshOnlineModels() {
    if (!this.configured()) return;
    try {
      const response = await fetch(`${this.config.baseURL}/models`, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      });
      const data = (await response.json()) as { data: { id: string }[] };

      this.models = data.data.map(m => {
        const id = this.config.modelIdPrefix
          ? `${this.config.modelIdPrefix}/${m.id}`
          : m.id;
        return {
          id,
          name: m.id, // Keep original name for UI display
          capabilities: [
            {
              input: [ModelInputType.Text],
              output: [ModelOutputType.Text, ModelOutputType.Object],
            },
          ],
        };
      });
      this._onlineModelList = this.models.map(m => m.id);
    } catch (e) {
      this.logger.error('Failed to fetch available models', e);
    }
  }

  private getRawModelId(modelId: string): string {
    if (
      this.config.modelIdPrefix &&
      modelId.startsWith(`${this.config.modelIdPrefix}/`)
    ) {
      return modelId.replace(`${this.config.modelIdPrefix}/`, '');
    }
    return modelId;
  }

  // Basic implementation similar to OpenAI provider but simplified
  async text(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotChatOptions = {}
  ): Promise<string> {
    const fullCond = { ...cond, outputType: ModelOutputType.Text };
    await this.checkParams({ messages, cond: fullCond, options });
    const model = this.selectModel(fullCond);
    const rawModelId = this.getRawModelId(model.id);

    try {
      metrics.ai.counter('chat_text_calls').add(1, { model: model.id });

      const [system, msgs] = await chatToGPTMessage(messages);

      const { text } = await generateText({
        model: this.#instance(rawModelId),
        system,
        messages: msgs,
        temperature: options.temperature ?? 0,
        maxOutputTokens: options.maxTokens ?? 4096,
        stopWhen: stepCountIs(this.MAX_STEPS),
        abortSignal: options.signal,
      });

      return text.trim();
    } catch (e: any) {
      metrics.ai.counter('chat_text_errors').add(1, { model: model.id });
      throw this.handleError(e, model.id);
    }
  }

  async *streamText(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotChatOptions = {}
  ): AsyncIterable<string> {
    const fullCond = {
      ...cond,
      outputType: ModelOutputType.Text,
    };
    await this.checkParams({ messages, cond: fullCond, options });
    const model = this.selectModel(fullCond);
    const rawModelId = this.getRawModelId(model.id);

    try {
      metrics.ai.counter('chat_text_stream_calls').add(1, { model: model.id });
      const [system, msgs] = await chatToGPTMessage(messages);

      const { fullStream } = streamText({
        model: this.#instance(rawModelId),
        system,
        messages: msgs,
        temperature: options.temperature ?? 0,
        maxOutputTokens: options.maxTokens ?? 4096,
        stopWhen: stepCountIs(this.MAX_STEPS),
        abortSignal: options.signal,
      });

      const citationParser = new CitationParser();
      const textParser = new TextStreamParser();

      for await (const chunk of fullStream) {
        switch (chunk.type) {
          case 'text-delta': {
            let result = textParser.parse(chunk);
            result = citationParser.parse(result);
            yield result;
            break;
          }
          case 'finish': {
            const footnotes = textParser.end();
            const result =
              citationParser.end() + (footnotes.length ? '\n' + footnotes : '');
            yield result;
            break;
          }
          default: {
            yield textParser.parse(chunk);
            break;
          }
        }
        if (options.signal?.aborted) {
          // ensure stream is cancelled
          // since fullStream is not an async generator we can't call return/throw
          // but we can break loop
          break;
        }
      }
    } catch (e: any) {
      metrics.ai.counter('chat_text_stream_errors').add(1, { model: model.id });
      throw this.handleError(e, model.id);
    }
  }

  override async *streamObject(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotChatOptions = {}
  ): AsyncIterable<StreamObject> {
    const fullCond = { ...cond, outputType: ModelOutputType.Object };
    await this.checkParams({ cond: fullCond, messages, options });
    const model = this.selectModel(fullCond);
    const rawModelId = this.getRawModelId(model.id);

    try {
      metrics.ai
        .counter('chat_object_stream_calls')
        .add(1, { model: model.id });
      // Pass rawModelId to getFullStream, but we need to update getFullStream to accept ID string or create a temp model obj
      const fullStream = await this.getFullStream(
        rawModelId,
        messages,
        options
      );
      const parser = new StreamObjectParser();
      for await (const chunk of fullStream) {
        const result = parser.parse(chunk);
        if (result) {
          yield result;
        }
        if (options.signal?.aborted) {
          await fullStream.cancel();
          break;
        }
      }
    } catch (e: any) {
      metrics.ai
        .counter('chat_object_stream_errors')
        .add(1, { model: model.id });
      throw this.handleError(e, model.id);
    }
  }

  private async getFullStream(
    modelId: string,
    messages: PromptMessage[],
    options: CopilotChatOptions = {}
  ) {
    const [system, msgs] = await chatToGPTMessage(messages);

    // TODO: Tools support for GenericOpenAI is disabled temporarily.
    // When tools are passed to LiteLLM/Gemini, the model returns empty responses
    // causing "model output must contain either output text or tool calls" error.
    // This needs investigation into LiteLLM tool format compatibility.
    // const tools = await this.getTools(options, modelId);
    // const hasTools = tools && Object.keys(tools).length > 0;

    const { fullStream } = streamText({
      model: this.#instance(modelId),
      system,
      messages: msgs as (CoreUserMessage | CoreAssistantMessage)[],
      temperature: options.temperature ?? 0,
      maxOutputTokens: options.maxTokens ?? 4096,
      abortSignal: options.signal,
    });
    return fullStream;
  }
}
