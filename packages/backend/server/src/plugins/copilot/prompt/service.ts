import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Prisma, PrismaClient } from '@prisma/client';

import { Config, OnEvent } from '../../../base';
import {
  PromptConfig,
  PromptConfigSchema,
  PromptMessage,
  PromptMessageSchema,
} from '../providers';
import { ChatPrompt } from './chat-prompt';
import { DotPrompt, DotPromptLoader } from './loader';
import {
  CopilotPromptScenario,
  prompts,
  refreshPrompts,
  Scenario,
} from './prompts';
import { normalizeScenarioConfig, ScenarioConfig } from './schema';

@Injectable()
export class PromptService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PromptService.name);
  private readonly cache = new Map<string, ChatPrompt>();
  private readonly dotpromptLoader = new DotPromptLoader();

  constructor(
    private readonly config: Config,
    private readonly db: PrismaClient
  ) {}

  async onApplicationBootstrap() {
    this.cache.clear();
    await refreshPrompts(this.db);
  }

  @OnEvent('config.init')
  async onConfigInit() {
    await this.setup(this.config.copilot?.scenarios);
  }

  @OnEvent('config.changed')
  async onConfigChanged(event: Events['config.changed']) {
    if ('copilot' in event.updates) {
      await this.setup(event.updates.copilot?.scenarios);
    }
  }

  protected async setup(scenarios?: CopilotPromptScenario) {
    if (!!scenarios && scenarios.override_enabled && scenarios.scenarios) {
      this.logger.log('Updating prompts based on scenarios...');
      for (const [scenario, model] of Object.entries(scenarios.scenarios)) {
        const promptNames = Scenario[scenario as keyof typeof Scenario] || [];
        if (!promptNames.length) continue;
        for (const name of promptNames) {
          const prompt = prompts.find(p => p.name === name);
          if (prompt && model) {
            await this.update(
              prompt.name,
              { model, modified: true },
              { model: { not: model } }
            );
          }
        }
      }
    } else {
      this.logger.log('No scenarios enabled, using default prompts.');
      const prompts = Object.values(Scenario).flat();
      for (const prompt of prompts) {
        await this.update(prompt, { modified: false });
      }
    }
  }

  /**
   * list prompt names
   * @returns prompt names
   */
  async listNames() {
    return this.db.aiPrompt
      .findMany({ select: { name: true } })
      .then(prompts => Array.from(new Set(prompts.map(p => p.name))));
  }

  async list() {
    return this.db.aiPrompt.findMany({
      select: {
        name: true,
        action: true,
        model: true,
        config: true,
        messages: {
          select: { role: true, content: true, params: true },
          orderBy: { idx: 'asc' },
        },
      },
      orderBy: { action: { sort: 'asc', nulls: 'first' } },
    });
  }

  /**
   * get prompt messages by prompt name
   * Priority: 1. Dotprompt file, 2. Database
   * @param name prompt name
   * @returns prompt messages
   */
  async get(name: string): Promise<ChatPrompt | null> {
    // skip cache in dev mode to ensure the latest prompt is always fetched
    if (!env.dev) {
      const cached = this.cache.get(name);
      if (cached) return cached;
    }

    // 1. Try dotprompt file first
    const dotprompt = await this.dotpromptLoader.load(name);
    if (dotprompt) {
      this.logger.log(`Loading prompt from dotprompt file: ${name}`);
      return this.convertDotPromptToChatPrompt(dotprompt, name);
    }

    // 2. Fall back to database (legacy)
    this.logger.debug(`Loading prompt from database: ${name}`);
    return this.getFromDatabase(name);
  }

  /**
   * Convert dotprompt to ChatPrompt with scenario config integration
   */
  private async convertDotPromptToChatPrompt(
    dotprompt: DotPrompt,
    name: string
  ): Promise<ChatPrompt> {
    // Get scenario config for this prompt
    const scenario = dotprompt.frontmatter.scenario || this.inferScenario(name);
    const scenarioConfig = this.getScenarioConfig(scenario);

    if (!scenarioConfig) {
      throw new Error(
        `No scenario config found for: ${scenario}. ` +
          `Please configure copilot.scenarios.scenarios.${scenario} in config.json`
      );
    }

    // Validate model format (must include provider prefix)
    const model = scenarioConfig.model;
    if (!model.includes('/')) {
      throw new Error(
        `Model must include provider prefix: ${model}. ` +
          `Expected format: provider/model-id (e.g., "openai/gpt-4o"). ` +
          `Please update copilot.scenarios.scenarios.${scenario}.model in config.json`
      );
    }

    // Merge config: scenario config > dotprompt config
    const mergedConfig: PromptConfig = {
      ...dotprompt.frontmatter.config,
      ...scenarioConfig.config,
    };

    // Add tools and proModels if specified
    if (dotprompt.frontmatter.tools) {
      (mergedConfig as any).tools = dotprompt.frontmatter.tools;
    }
    if (scenarioConfig.proModels) {
      (mergedConfig as any).proModels = scenarioConfig.proModels;
    }

    // Parse prompt template to messages
    const messages = this.dotpromptLoader.parsePromptTemplate(
      dotprompt.content
    );

    const chatPrompt = ChatPrompt.createFromPrompt({
      name,
      model, // From scenario config
      optionalModels: scenarioConfig.optionalModels || [model],
      action: scenario, // Use scenario as action
      messages,
      config: mergedConfig,
    });

    this.cache.set(name, chatPrompt);
    this.logger.log(
      `✅ Loaded dotprompt: ${name} (scenario: ${scenario}, model: ${model})`
    );
    return chatPrompt;
  }

  /**
   * Get scenario configuration from config.json
   */
  private getScenarioConfig(scenario: string): ScenarioConfig | null {
    const scenariosConfig = this.config.copilot?.scenarios;
    if (!scenariosConfig?.scenarios) return null;

    // Normalize to enhanced format (handles both legacy and new formats)
    const normalized = normalizeScenarioConfig(scenariosConfig);
    return normalized.scenarios?.[scenario] || null;
  }

  /**
   * Infer scenario from prompt name
   * Maps prompt name to scenario (e.g., "chat" → "chat", "coding-apply-updates" → "coding")
   */
  private inferScenario(promptName: string): string {
    // Check if prompt name matches any scenario's prompt names
    for (const [scenario, names] of Object.entries(Scenario)) {
      if (
        Array.isArray(names) &&
        (names as readonly string[]).includes(promptName)
      ) {
        return scenario;
      }
    }

    // Fallback: try to infer from name prefix
    if (promptName.startsWith('coding-')) return 'coding';
    if (promptName.startsWith('summary')) return 'polish_and_summarize';
    if (promptName.startsWith('translate')) return 'quick_decision_making';

    // Default to chat
    return 'chat';
  }

  /**
   * Legacy database lookup (backward compatibility)
   */
  private async getFromDatabase(name: string): Promise<ChatPrompt | null> {
    const prompt = await this.db.aiPrompt.findUnique({
      where: { name },
      select: {
        name: true,
        action: true,
        model: true,
        optionalModels: true,
        config: true,
        messages: {
          select: {
            role: true,
            content: true,
            params: true,
          },
          orderBy: {
            idx: 'asc',
          },
        },
      },
    });

    const messages = PromptMessageSchema.array().safeParse(prompt?.messages);
    const config = PromptConfigSchema.safeParse(prompt?.config);
    if (prompt && messages.success && config.success) {
      const chatPrompt = ChatPrompt.createFromPrompt({
        ...prompt,
        config: config.data,
        messages: messages.data,
      });
      this.cache.set(name, chatPrompt);
      return chatPrompt;
    }
    return null;
  }

  async set(
    name: string,
    model: string,
    messages: PromptMessage[],
    config?: PromptConfig | null
  ) {
    return await this.db.aiPrompt
      .create({
        data: {
          name,
          model,
          config: config || undefined,
          messages: {
            create: messages.map((m, idx) => ({
              idx,
              ...m,
              attachments: m.attachments || undefined,
              params: m.params || undefined,
            })),
          },
        },
      })
      .then(ret => ret.id);
  }

  @Transactional()
  async update(
    name: string,
    data: {
      messages?: PromptMessage[];
      model?: string;
      modified?: boolean;
      config?: PromptConfig;
    },
    where?: Prisma.AiPromptWhereInput
  ) {
    const { config, messages, model, modified } = data;
    const existing = await this.db.aiPrompt
      .count({ where: { ...where, name } })
      .then(count => count > 0);
    if (existing) {
      await this.db.aiPrompt.update({
        where: { name },
        data: {
          config: config || undefined,
          updatedAt: new Date(),
          modified,
          model,
          messages: messages
            ? {
                // cleanup old messages
                deleteMany: {},
                create: messages.map((m, idx) => ({
                  idx,
                  ...m,
                  attachments: m.attachments || undefined,
                  params: m.params || undefined,
                })),
              }
            : undefined,
        },
      });

      this.cache.delete(name);
    }
  }

  async delete(name: string) {
    const { id } = await this.db.aiPrompt.delete({ where: { name } });
    this.cache.delete(name);
    return id;
  }
}
