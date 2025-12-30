#!/usr/bin/env tsx
/**
 * Migration script: Convert hardcoded prompts to dotprompt files
 *
 * This script reads prompts from prompts.ts and generates .prompt files
 * with proper YAML frontmatter.
 *
 * Usage:
 *   yarn workspace @affine/server migrate-to-dotprompt
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  params?: Record<string, any>;
  attachments?: any[];
}

interface PromptConfig {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  tools?: string[];
  proModels?: string[];
  requireContent?: boolean;
  requireAttachment?: boolean;
  maxRetries?: number;
  modelName?: string;
  loras?: any[];
  [key: string]: any;
}

interface Prompt {
  name: string;
  action?: string;
  model: string;
  optionalModels?: string[];
  messages: PromptMessage[];
  config?: PromptConfig;
}

/**
 * Infer scenario from prompt name
 */
function inferScenario(promptName: string, Scenario: any): string {
  for (const [scenario, names] of Object.entries(Scenario)) {
    if (
      Array.isArray(names) &&
      (names as readonly string[]).includes(promptName)
    ) {
      return scenario;
    }
  }

  // Fallback inference
  if (promptName.startsWith('workflow:')) {
    const parts = promptName.split(':');
    return `workflow_${parts[1]}`;
  }

  return 'unknown';
}

/**
 * Generate filename from prompt name
 */
function generateFilename(promptName: string): string {
  return promptName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-:]/g, '')
    .replace(/^-+|-+$/g, '');
}

/**
 * Convert messages to prompt content
 * Handles multi-message prompts by combining them
 */
function messagesToContent(messages: PromptMessage[]): string {
  if (messages.length === 0) {
    return '';
  }

  if (messages.length === 1) {
    return messages[0].content.trim();
  }

  // Multi-message: combine with role markers
  return messages
    .map(msg => {
      if (msg.role === 'system') {
        return msg.content.trim();
      } else if (msg.role === 'user') {
        return `---\n\n${msg.content.trim()}`;
      } else if (msg.role === 'assistant') {
        return `[Assistant Context]\n${msg.content.trim()}`;
      }
      return msg.content.trim();
    })
    .join('\n\n');
}

/**
 * Extract frontmatter config from prompt config
 */
function extractFrontmatterConfig(config?: PromptConfig): Record<string, any> {
  if (!config) return {};

  const frontmatter: Record<string, any> = {};

  // Extract config fields (exclude tools and proModels - they go in frontmatter root)
  const configFields = { ...config };
  delete configFields.tools;
  delete configFields.proModels;

  if (Object.keys(configFields).length > 0) {
    frontmatter.config = configFields;
  }

  return frontmatter;
}

/**
 * Generate dotprompt file content
 */
function generateDotprompt(prompt: Prompt, Scenario: any): string {
  const scenario = inferScenario(prompt.name, Scenario);

  const frontmatter: Record<string, any> = {
    scenario,
  };

  // Add tools if present
  if (prompt.config?.tools && prompt.config.tools.length > 0) {
    frontmatter.tools = prompt.config.tools;
  }

  // Add config (excluding tools and proModels)
  const configFrontmatter = extractFrontmatterConfig(prompt.config);
  if (configFrontmatter.config) {
    frontmatter.config = configFrontmatter.config;
  }

  // Convert messages to content
  const content = messagesToContent(prompt.messages);

  // Generate YAML frontmatter
  const yamlFrontmatter = yaml.stringify(frontmatter, {
    lineWidth: 0, // Don't wrap lines
    defaultStringType: 'PLAIN',
  });

  // Combine into dotprompt format
  return `---\n${yamlFrontmatter}---\n${content}\n`;
}

/**
 * Main migration function
 */
async function migrate() {
  // Dynamic import to bypass eslint restriction
  const { prompts, Scenario } =
    await import('../src/plugins/copilot/prompt/prompts.js');

  const outputDir = path.join(__dirname, '../src/plugins/copilot/prompts');

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  console.log('🚀 Starting dotprompt migration...\n');
  console.log(`📁 Output directory: ${outputDir}\n`);

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (const prompt of prompts as Prompt[]) {
    const filename = generateFilename(prompt.name);
    const filepath = path.join(outputDir, `${filename}.prompt`);

    try {
      // Check if file already exists
      try {
        await fs.access(filepath);
        console.log(`⏭️  Skipping (exists): ${filename}.prompt`);
        skipCount++;
        continue;
      } catch {
        // File doesn't exist, proceed
      }

      // Skip workflow parent prompts (they have no messages)
      if (prompt.messages.length === 0) {
        console.log(`⏭️  Skipping (no messages): ${filename}.prompt`);
        skipCount++;
        continue;
      }

      // Generate dotprompt content
      const content = generateDotprompt(prompt, Scenario);

      // Write file
      await fs.writeFile(filepath, content, 'utf-8');

      console.log(
        `✅ Created: ${filename}.prompt (scenario: ${inferScenario(prompt.name, Scenario)})`
      );
      successCount++;
    } catch (error) {
      console.error(`❌ Error creating ${filename}.prompt:`, error);
      errorCount++;
    }
  }

  console.log('\n📊 Migration Summary:');
  console.log(`   ✅ Created: ${successCount} files`);
  console.log(`   ⏭️  Skipped: ${skipCount} files`);
  console.log(`   ❌ Errors: ${errorCount} files`);
  console.log(`\n🎉 Migration complete!`);

  if (successCount > 0) {
    console.log('\n📝 Next steps:');
    console.log('   1. Review generated .prompt files');
    console.log(
      '   2. Update config.json with enhanced scenario configuration'
    );
    console.log('   3. Test that prompts load correctly');
    console.log('   4. Commit the generated files');
  }
}

// Run migration
migrate().catch(error => {
  console.error('💥 Migration failed:', error);
  process.exit(1);
});
