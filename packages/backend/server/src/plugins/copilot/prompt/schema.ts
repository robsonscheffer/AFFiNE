import { PromptConfig } from '../providers';

/**
 * Enhanced Scenario Configuration
 * Defines model selection and UI options for each scenario
 */
export interface ScenarioConfig {
  /**
   * Model selection (REQUIRED)
   * Format: provider/model-id (e.g., "openai/gpt-4o", "litellm/llama-3")
   * The provider prefix is used to route to the correct provider
   */
  model: string;

  /**
   * UI model selector options (OPTIONAL)
   * Only for scenarios with user choice (e.g., chat)
   * Array of provider/model-id strings
   */
  optionalModels?: string[];

  /**
   * Premium models (OPTIONAL)
   * Requires active subscription to use
   * Array of provider/model-id strings
   */
  proModels?: string[];

  /**
   * Optional model parameter overrides
   * These override the defaults from the dotprompt file
   */
  config?: Partial<PromptConfig>;
}

/**
 * Enhanced Copilot Scenarios Configuration
 * Replaces the simple string-based scenario config
 */
export interface EnhancedCopilotPromptScenario {
  /**
   * Enable scenario-based model overrides
   */
  override_enabled?: boolean;

  /**
   * Scenario configurations
   * Maps scenario name to its configuration
   */
  scenarios?: Partial<Record<string, ScenarioConfig>>;
}

/**
 * Legacy scenario configuration (for backward compatibility)
 * Maps scenario name to model string
 */
export interface LegacyCopilotPromptScenario {
  override_enabled?: boolean;
  scenarios?: Partial<Record<string, string>>;
}

/**
 * Union type for backward compatibility
 */
export type CopilotPromptScenarioConfig =
  | EnhancedCopilotPromptScenario
  | LegacyCopilotPromptScenario;

/**
 * Type guard to check if config is enhanced format
 */
export function isEnhancedScenarioConfig(
  config: CopilotPromptScenarioConfig
): config is EnhancedCopilotPromptScenario {
  if (!config.scenarios) return false;

  // Check if any scenario value is an object (enhanced) vs string (legacy)
  const firstScenario = Object.values(config.scenarios)[0];
  return typeof firstScenario === 'object' && firstScenario !== null;
}

/**
 * Normalize scenario config to enhanced format
 * Converts legacy string format to enhanced object format
 */
export function normalizeScenarioConfig(
  config: CopilotPromptScenarioConfig
): EnhancedCopilotPromptScenario {
  if (isEnhancedScenarioConfig(config)) {
    return config;
  }

  // Convert legacy format
  const enhanced: EnhancedCopilotPromptScenario = {
    override_enabled: config.override_enabled,
    scenarios: {},
  };

  if (config.scenarios) {
    for (const [scenario, model] of Object.entries(config.scenarios)) {
      if (typeof model === 'string') {
        enhanced.scenarios![scenario] = { model };
      }
    }
  }

  return enhanced;
}
