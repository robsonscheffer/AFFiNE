import {
  createOpenAI,
  openai,
  type OpenAIProvider as VercelOpenAIProvider,
  OpenAIResponsesProviderOptions,
} from '@ai-sdk/openai';
import {
  createOpenAICompatible,
  type OpenAICompatibleProvider as VercelOpenAICompatibleProvider,
} from '@ai-sdk/openai-compatible';
import {
  AISDKError,
  embedMany,
  experimental_generateImage as generateImage,
  generateObject,
  generateText,
  stepCountIs,
  streamText,
  Tool,
} from 'ai';
import { z } from 'zod';

import {
  CopilotPromptInvalid,
  CopilotProviderNotSupported,
  CopilotProviderSideError,
  metrics,
  UserFriendlyError,
} from '../../../base';
import { CopilotProvider } from './provider';
import type {
  CopilotChatOptions,
  CopilotChatTools,
  CopilotEmbeddingOptions,
  CopilotImageOptions,
  CopilotProviderModel,
  CopilotStructuredOptions,
  ModelConditions,
  ModelFullConditions,
  PromptMessage,
  StreamObject,
} from './types';
import { CopilotProviderType, ModelInputType, ModelOutputType } from './types';
import {
  chatToGPTMessage,
  CitationParser,
  StreamObjectParser,
  TextStreamParser,
} from './utils';

export const DEFAULT_DIMENSIONS = 256;

export type OpenAIConfig = {
  apiKey: string;
  baseURL?: string;
  oldApiStyle?: boolean;
  headers?: Record<string, string>;
};

const ModelListSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

const ImageResponseSchema = z.union([
  z.object({
    data: z.array(z.object({ b64_json: z.string() })),
  }),
  z.object({
    error: z.object({
      message: z.string(),
      type: z.string().nullish(),
      param: z.any().nullish(),
      code: z.union([z.string(), z.number()]).nullish(),
    }),
  }),
]);
const LogProbsSchema = z.array(
  z.object({
    token: z.string(),
    logprob: z.number(),
    top_logprobs: z.array(
      z.object({
        token: z.string(),
        logprob: z.number(),
      })
    ),
  })
);

export class OpenAIProvider extends CopilotProvider<OpenAIConfig> {
  readonly type = CopilotProviderType.OpenAI;

  readonly models = [
    // Text to Text models
    {
      name: 'GPT 4o',
      id: 'gpt-4o',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text, ModelOutputType.Object],
        },
      ],
    },
    // FIXME(@darkskygit): deprecated
    {
      name: 'GPT 4o 2024-08-06',
      id: 'gpt-4o-2024-08-06',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text, ModelOutputType.Object],
        },
      ],
    },
    {
      name: 'GPT 4o Mini',
      id: 'gpt-4o-mini',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text, ModelOutputType.Object],
        },
      ],
    },
    // FIXME(@darkskygit): deprecated
    {
      name: 'GPT 4o Mini 2024-07-18',
      id: 'gpt-4o-mini-2024-07-18',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text, ModelOutputType.Object],
        },
      ],
    },
    {
      name: 'GPT 4.1',
      id: 'gpt-4.1',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [
            ModelOutputType.Text,
            ModelOutputType.Object,
            ModelOutputType.Structured,
          ],
          defaultForOutputType: true,
        },
      ],
    },
    {
      name: 'GPT 5',
      id: 'gpt-5',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [
            ModelOutputType.Text,
            ModelOutputType.Object,
            ModelOutputType.Structured,
          ],
        },
      ],
    },
    {
      name: 'GPT 5.2',
      id: 'gpt-5.2',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [
            ModelOutputType.Text,
            ModelOutputType.Object,
            ModelOutputType.Structured,
          ],
        },
      ],
    },
    {
      name: 'GPT 5 Mini',
      id: 'gpt-5-mini',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text, ModelOutputType.Object],
        },
      ],
    },
    {
      name: 'GPT 5 Nano',
      id: 'gpt-5-nano',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text, ModelOutputType.Object],
        },
      ],
    },
    {
      name: 'GPT 4.1 2025-04-14',
      id: 'gpt-4.1-2025-04-14',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [
            ModelOutputType.Text,
            ModelOutputType.Object,
            ModelOutputType.Structured,
          ],
        },
      ],
    },
    {
      name: 'GPT 4.1 Mini',
      id: 'gpt-4.1-mini',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [
            ModelOutputType.Text,
            ModelOutputType.Object,
            ModelOutputType.Structured,
          ],
        },
      ],
    },
    {
      name: 'GPT 4.1 Nano',
      id: 'gpt-4.1-nano',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [
            ModelOutputType.Text,
            ModelOutputType.Object,
            ModelOutputType.Structured,
          ],
        },
      ],
    },
    {
      name: 'GPT 5',
      id: 'gpt-5',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [
            ModelOutputType.Text,
            ModelOutputType.Object,
            ModelOutputType.Structured,
          ],
        },
      ],
    },
    {
      name: 'GPT 5 2025-08-07',
      id: 'gpt-5-2025-08-07',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [
            ModelOutputType.Text,
            ModelOutputType.Object,
            ModelOutputType.Structured,
          ],
        },
      ],
    },
    {
      name: 'GPT 5 Mini',
      id: 'gpt-5-mini',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [
            ModelOutputType.Text,
            ModelOutputType.Object,
            ModelOutputType.Structured,
          ],
        },
      ],
    },
    {
      name: 'GPT 5 Nano',
      id: 'gpt-5-nano',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [
            ModelOutputType.Text,
            ModelOutputType.Object,
            ModelOutputType.Structured,
          ],
        },
      ],
    },
    {
      name: 'GPT O1',
      id: 'o1',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text, ModelOutputType.Object],
        },
      ],
    },
    {
      name: 'GPT O3',
      id: 'o3',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text, ModelOutputType.Object],
        },
      ],
    },
    {
      name: 'GPT O4 Mini',
      id: 'o4-mini',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Text, ModelOutputType.Object],
        },
      ],
    },
    // Embedding models
    {
      id: 'text-embedding-3-large',
      capabilities: [
        {
          input: [ModelInputType.Text],
          output: [ModelOutputType.Embedding],
          defaultForOutputType: true,
        },
      ],
    },
    {
      id: 'text-embedding-3-small',
      capabilities: [
        {
          input: [ModelInputType.Text],
          output: [ModelOutputType.Embedding],
        },
      ],
    },
    // Image generation models
    {
      id: 'dall-e-3',
      capabilities: [
        {
          input: [ModelInputType.Text],
          output: [ModelOutputType.Image],
        },
      ],
    },
    {
      id: 'gpt-image-1',
      capabilities: [
        {
          input: [ModelInputType.Text, ModelInputType.Image],
          output: [ModelOutputType.Image],
          defaultForOutputType: true,
        },
      ],
    },
  ];

  #instance!: VercelOpenAIProvider | VercelOpenAICompatibleProvider;

  override configured(): boolean {
    // If selfhosted, we allow permissive configuration (e.g. custom baseURL without apiKey)
    if (env.selfhosted) return true;
    return !!this.config.apiKey;
  }

  // Override to allow permissive matching when using custom baseURL
  override async match(cond: ModelConditions = {}): Promise<boolean> {
    const isStrictMatch = await super.match(cond);
    if (isStrictMatch) return true;

    // Permissive check: if selfhosted (where online fetch happens), and we have a specific model request,
    // we assume the user knows what they are doing even if auto-discovery fails.
    if (env.selfhosted && cond.modelId) {
      this.logger.debug(
        `Permissive match for model ${cond.modelId} (selfhosted mode)`
      );
      return true;
    }
    this.logger.warn(
      `Match failed for model ${cond.modelId} in OpenAIProvider`
    );
    return false;
  }

  protected override selectModel(cond: ModelConditions): CopilotProviderModel {
    try {
      return super.selectModel(cond);
    } catch (error) {
      // If strict selection fails, fall back to permissive mode if conditions are met
      if (env.selfhosted && cond.modelId) {
        this.logger.debug(
          `Synthesizing model capability for ${cond.modelId} (selfhosted mode)`
        );
        // cast to any to access outputType which might not be in ModelConditions but available at runtime
        // or effectively treat as ModelFullConditions
        const fullCond = cond as ModelFullConditions;
        return {
          id: cond.modelId,
          capabilities: [
            {
              input: cond.inputTypes || [ModelInputType.Text],
              output: fullCond.outputType ? [fullCond.outputType] : [],
            },
          ],
        };
      }
      this.logger.error(
        `SelectModel failed for ${cond.modelId} and no fallback available`
      );
      throw error;
    }
  }

  protected override setup() {
    super.setup();
    this.logger.debug(
      `Setup OpenAIProvider: oldApiStyle=${this.config.oldApiStyle}, baseURL=${this.config.baseURL}, apiKey=${this.config.apiKey ? '***' : 'undefined'}`
    );
    this.#instance =
      this.config.oldApiStyle && this.config.baseURL
        ? createOpenAICompatible({
            name: 'openai-compatible-old-style',
            apiKey: this.config.apiKey,
            baseURL: this.config.baseURL,
          })
        : createOpenAI({
            apiKey: this.config.apiKey,
            baseURL: this.config.baseURL,
          });
  }

  private handleError(
    e: any,
    model: string,
    options: CopilotImageOptions = {}
  ) {
    if (e instanceof UserFriendlyError) {
      return e;
    } else if (e instanceof AISDKError) {
      if (e.message.includes('safety') || e.message.includes('risk')) {
        metrics.ai
          .counter('chat_text_risk_errors')
          .add(1, { model, user: options.user || undefined });
      }

      return new CopilotProviderSideError({
        provider: this.type,
        kind: e.name || 'unknown',
        message: e.message,
      });
    } else {
      return new CopilotProviderSideError({
        provider: this.type,
        kind: 'unexpected_response',
        message: e?.message || 'Unexpected openai response',
      });
    }
  }

  override async refreshOnlineModels() {
    try {
      const baseUrl = this.config.baseURL || 'https://api.openai.com/v1';
      if (this.config.apiKey && baseUrl && !this.onlineModelList.length) {
        const { data } = await fetch(`${baseUrl}/models`, {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
        })
          .then(r => r.json())
          .then(r => ModelListSchema.parse(r));
        this._onlineModelList = data.map(model => model.id);
      }
    } catch (e) {
      this.logger.error('Failed to fetch available models', e);
    }
  }

  override getProviderSpecificTools(
    toolName: CopilotChatTools,
    model: string
  ): [string, Tool?] | undefined {
    if (
      toolName === 'webSearch' &&
      'responses' in this.#instance &&
      !this.isReasoningModel(model)
    ) {
      return ['web_search_preview', openai.tools.webSearchPreview({})];
    } else if (toolName === 'docEdit') {
      return ['doc_edit', undefined];
    }
    return;
  }

  async text(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotChatOptions = {}
  ): Promise<string> {
    const fullCond = { ...cond, outputType: ModelOutputType.Text };
    await this.checkParams({ messages, cond: fullCond, options });
    const model = this.selectModel(fullCond);

    try {
      metrics.ai.counter('chat_text_calls').add(1, { model: model.id });

      const [system, msgs] = await chatToGPTMessage(messages);

      const modelInstance =
        'responses' in this.#instance
          ? this.#instance.responses(model.id)
          : this.#instance(model.id);

      const { text } = await generateText({
        model: modelInstance,
        system,
        messages: msgs,
        temperature: options.temperature ?? 0,
        maxOutputTokens: options.maxTokens ?? 4096,
        providerOptions: {
          openai: this.getOpenAIOptions(options, model.id),
        },
        tools: await this.getTools(options, model.id),
        stopWhen: stepCountIs(this.MAX_STEPS),
        abortSignal: options.signal,
        headers: {
          'X-Affine-User-Id': options.user ?? 'unknown',
          'X-OpenWebUI-User-Id': options.user ?? 'unknown',
          'x-litellm-user-id': options.user ?? 'unknown',
          ...(options.email
            ? {
                'X-Affine-User-Email': options.email,
                'X-OpenWebUI-User-Email': options.email,
                'x-litellm-user-email': options.email,
              }
            : {}),
        },
      });

      this.logger.debug(
        `[LiteLLM Request] Model: ${model.id} | User: ${options.user ?? 'unknown'} | Email: ${options.email ?? 'unknown'} | Headers: ${JSON.stringify(
          this.getExtraHeaders(options)
        )}`
      );

      return text.trim();
    } catch (e: any) {
      metrics.ai.counter('chat_text_errors').add(1, { model: model.id });
      throw this.handleError(e, model.id, options);
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

    try {
      metrics.ai.counter('chat_text_stream_calls').add(1, { model: model.id });
      const fullStream = await this.getFullStream(model, messages, options);
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
          await fullStream.cancel();
          break;
        }
      }
    } catch (e: any) {
      metrics.ai.counter('chat_text_stream_errors').add(1, { model: model.id });
      throw this.handleError(e, model.id, options);
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

    try {
      metrics.ai
        .counter('chat_object_stream_calls')
        .add(1, { model: model.id });
      const fullStream = await this.getFullStream(model, messages, options);
      // Pass includeReasoning to parser - only show reasoning when explicitly enabled
      const parser = new StreamObjectParser({
        includeReasoning: options.reasoning ?? false,
      });
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
      throw this.handleError(e, model.id, options);
    }
  }

  override async structure(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotStructuredOptions = {}
  ): Promise<string> {
    const fullCond = { ...cond, outputType: ModelOutputType.Structured };
    await this.checkParams({ messages, cond: fullCond, options });
    const model = this.selectModel(fullCond);

    try {
      metrics.ai.counter('chat_text_calls').add(1, { model: model.id });

      const [system, msgs, schema] = await chatToGPTMessage(messages);
      if (!schema) {
        throw new CopilotPromptInvalid('Schema is required');
      }

      const modelInstance =
        'responses' in this.#instance
          ? this.#instance.responses(model.id)
          : this.#instance(model.id);

      const { object } = await generateObject({
        model: modelInstance,
        system,
        messages: msgs,
        temperature: options.temperature ?? 0,
        maxOutputTokens: options.maxTokens ?? 4096,
        maxRetries: options.maxRetries ?? 3,
        schema,
        providerOptions: {
          openai: options.user ? { user: options.user } : {},
        },
        abortSignal: options.signal,
        headers: this.getExtraHeaders(options),
      });

      return JSON.stringify(object);
    } catch (e: any) {
      metrics.ai.counter('chat_text_errors').add(1, { model: model.id });
      throw this.handleError(e, model.id, options);
    }
  }

  override async rerank(
    cond: ModelConditions,
    chunkMessages: PromptMessage[][],
    options: CopilotChatOptions = {}
  ): Promise<number[]> {
    const fullCond = { ...cond, outputType: ModelOutputType.Text };
    await this.checkParams({ messages: [], cond: fullCond, options });
    const model = this.selectModel(fullCond);
    // get the log probability of "yes"/"no"
    const instance =
      'chat' in this.#instance
        ? this.#instance.chat(model.id)
        : this.#instance(model.id);

    const scores = await Promise.all(
      chunkMessages.map(async messages => {
        const [system, msgs] = await chatToGPTMessage(messages);

        const result = await generateText({
          model: instance,
          system,
          messages: msgs,
          temperature: 0,
          maxOutputTokens: 16,
          providerOptions: {
            openai: {
              ...this.getOpenAIOptions(options, model.id),
              logprobs: 16,
            },
          },
          abortSignal: options.signal,
          headers: {
            ...this.getExtraHeaders(options),
          },
        });

        const topMap: Record<string, number> = LogProbsSchema.parse(
          result.providerMetadata?.openai?.logprobs
        )[0].top_logprobs.reduce<Record<string, number>>(
          (acc, { token, logprob }) => ({ ...acc, [token]: logprob }),
          {}
        );

        const findLogProb = (token: string): number => {
          // OpenAI often includes a leading space, so try matching '.yes', '_yes', ' yes' and 'yes'
          return [...'_:. "-\t,(=_“'.split('').map(c => c + token), token]
            .flatMap(v => [v, v.toLowerCase(), v.toUpperCase()])
            .reduce<number>(
              (best, key) =>
                (topMap[key] ?? Number.NEGATIVE_INFINITY) > best
                  ? topMap[key]
                  : best,
              Number.NEGATIVE_INFINITY
            );
        };

        const logYes = findLogProb('Yes');
        const logNo = findLogProb('No');

        const pYes = Math.exp(logYes);
        const pNo = Math.exp(logNo);
        const prob = pYes + pNo === 0 ? 0 : pYes / (pYes + pNo);

        return prob;
      })
    );

    return scores;
  }

  private async getFullStream(
    model: CopilotProviderModel,
    messages: PromptMessage[],
    options: CopilotChatOptions = {}
  ) {
    const [system, msgs] = await chatToGPTMessage(messages);
    const modelInstance =
      'responses' in this.#instance
        ? this.#instance.responses(model.id)
        : this.#instance(model.id);
    const { fullStream } = streamText({
      model: modelInstance,
      system,
      messages: msgs,
      frequencyPenalty: options.frequencyPenalty ?? 0,
      presencePenalty: options.presencePenalty ?? 0,
      temperature: options.temperature ?? 0,
      maxOutputTokens: options.maxTokens ?? 4096,
      providerOptions: {
        openai: this.getOpenAIOptions(options, model.id),
      },
      tools: await this.getTools(options, model.id),
      stopWhen: stepCountIs(this.MAX_STEPS),
      abortSignal: options.signal,
      headers: this.getExtraHeaders(options),
    });

    this.logger.debug(
      `[LiteLLM Stream] Model: ${model.id} | User: ${options.user ?? 'unknown'} | Email: ${options.email ?? 'unknown'}`
    );
    return fullStream;
  }

  // ====== text to image ======
  private async *generateImageWithAttachments(
    model: string,
    prompt: string,
    attachments: NonNullable<PromptMessage['attachments']>
  ): AsyncGenerator<string> {
    const form = new FormData();
    form.set('model', model);
    form.set('prompt', prompt);
    form.set('output_format', 'webp');

    for (const [idx, entry] of attachments.entries()) {
      const url = typeof entry === 'string' ? entry : entry.attachment;
      const resp = await fetch(url);
      if (resp.ok) {
        const type = resp.headers.get('content-type');
        if (type && type.startsWith('image/')) {
          const buffer = new Uint8Array(await resp.arrayBuffer());
          const file = new File([buffer], `${idx}.png`, { type });
          form.append('image[]', file);
        }
      }
    }

    if (!form.getAll('image[]').length) {
      throw new CopilotPromptInvalid(
        'No valid image attachments found. Please attach images.'
      );
    }

    const url = `${this.config.baseURL || 'https://api.openai.com/v1'}/images/edits`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    }

    const json = await res.json();
    const imageResponse = ImageResponseSchema.safeParse(json);
    if (imageResponse.success) {
      const data = imageResponse.data;
      if ('error' in data) {
        throw new Error(data.error.message);
      } else {
        for (const image of data.data) {
          yield `data:image/webp;base64,${image.b64_json}`;
        }
      }
    } else {
      throw new Error(imageResponse.error.message);
    }
  }

  override async *streamImages(
    cond: ModelConditions,
    messages: PromptMessage[],
    options: CopilotImageOptions = {}
  ) {
    const fullCond = { ...cond, outputType: ModelOutputType.Image };
    await this.checkParams({ messages, cond: fullCond, options });
    const model = this.selectModel(fullCond);

    if (!('image' in this.#instance)) {
      throw new CopilotProviderNotSupported({
        provider: this.type,
        kind: 'image',
      });
    }

    metrics.ai
      .counter('generate_images_stream_calls')
      .add(1, { model: model.id });

    const { content: prompt, attachments } = [...messages].pop() || {};
    if (!prompt) throw new CopilotPromptInvalid('Prompt is required');

    try {
      if (attachments && attachments.length > 0) {
        yield* this.generateImageWithAttachments(model.id, prompt, attachments);
      } else {
        const modelInstance = this.#instance.image(model.id);
        const result = await generateImage({
          model: modelInstance,
          prompt,
          providerOptions: {
            openai: {
              quality: options.quality || null,
            },
          },
        });

        const imageUrls = result.images.map(
          image => `data:image/png;base64,${image.base64}`
        );

        for (const imageUrl of imageUrls) {
          yield imageUrl;
          if (options.signal?.aborted) {
            break;
          }
        }
      }
      return;
    } catch (e: any) {
      metrics.ai.counter('generate_images_errors').add(1, { model: model.id });
      throw this.handleError(e, model.id, options);
    }
  }

  override async embedding(
    cond: ModelConditions,
    messages: string | string[],
    options: CopilotEmbeddingOptions = { dimensions: DEFAULT_DIMENSIONS }
  ): Promise<number[][]> {
    messages = Array.isArray(messages) ? messages : [messages];
    const fullCond = { ...cond, outputType: ModelOutputType.Embedding };
    await this.checkParams({ embeddings: messages, cond: fullCond, options });
    const model = this.selectModel(fullCond);

    this.logger.debug(`Generating embedding for model: ${model.id}`);
    const instanceHasEmbedding = 'embedding' in this.#instance;
    this.logger.debug(
      `OpenAI instance supports embedding: ${instanceHasEmbedding}`
    );

    let modelInstance;
    if ('embedding' in this.#instance) {
      // @ts-ignore
      modelInstance = this.#instance.embedding(model.id);
    } else {
      // Fallback: create a temporary OpenAI instance for embedding if the main one (e.g. OpenAICompatible) doesn't support it.
      // This assumes the API is compatible enough for standard OpenAI embedding calls.
      const fallbackInstance = createOpenAI({
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
      });
      modelInstance = fallbackInstance.embedding(model.id);
    }

    try {
      metrics.ai
        .counter('generate_embedding_calls')
        .add(1, { model: model.id });

      const { embeddings } = await embedMany({
        model: modelInstance,
        values: messages,
        providerOptions: {
          openai: {
            dimensions: options.dimensions || DEFAULT_DIMENSIONS,
          },
        },
        headers: {
          'X-Affine-User-Id': options.user ?? 'unknown',
          'X-OpenWebUI-User-Id': options.user ?? 'unknown',
          'x-litellm-user-id': options.user ?? 'unknown',
          ...(options.email
            ? {
                'X-Affine-User-Email': options.email,
                'X-OpenWebUI-User-Email': options.email,
                'x-litellm-user-email': options.email,
              }
            : {}),
        },
      });

      this.logger.debug(
        `[LiteLLM Embedding] Model: ${model.id} | User: ${options.user ?? 'unknown'} | Email: ${options.email ?? 'unknown'} | Headers: ${JSON.stringify(
          this.getExtraHeaders(options)
        )}`
      );

      return embeddings.filter(v => v && Array.isArray(v));
    } catch (e: any) {
      metrics.ai
        .counter('generate_embedding_errors')
        .add(1, { model: model.id });
      throw this.handleError(e, model.id, options);
    }
  }

  private getOpenAIOptions(options: CopilotChatOptions, model: string) {
    const result: OpenAIResponsesProviderOptions = {};
    if (options?.reasoning && this.isReasoningModel(model)) {
      result.reasoningEffort = 'medium';
      result.reasoningSummary = 'detailed';
    }
    if (options?.user) {
      result.user = options.user;
    }
    return result;
  }

  private isReasoningModel(model: string) {
    // o series reasoning models
    return model.startsWith('o') || model.startsWith('gpt-5');
  }

  private getExtraHeaders(options: { user?: string; email?: string }) {
    const headers: Record<string, string> = {
      'X-Affine-User-Id': options.user ?? 'unknown',
      ...(options.email ? { 'X-Affine-User-Email': options.email } : {}),
    };

    if (this.config.headers) {
      for (const [key, value] of Object.entries(this.config.headers)) {
        // @ts-ignore
        headers[key] = value
          .replace('{{user}}', options.user ?? 'unknown')
          .replace('{{email}}', options.email ?? 'unknown');
      }
    }

    return headers;
  }
}
