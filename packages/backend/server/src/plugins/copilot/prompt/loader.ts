import { Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'yaml';

import { PromptConfig, PromptMessage } from '../providers';

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Frontmatter schema for .prompt files
 * Defines metadata and configuration for prompts
 */
export interface DotPromptFrontmatter {
  /** Optional: scenario identifier (for auto-discovery) */
  scenario?: string;

  /** Optional: tools available to this prompt */
  tools?: string[];

  /** Optional: model parameters (NOT model selection) */
  config?: PromptConfig;

  /** Optional: input schema (for validation) */
  input?: {
    schema?: Record<string, any>;
  };
}

/**
 * Parsed dotprompt file structure
 */
export interface DotPrompt {
  /** YAML frontmatter metadata */
  frontmatter: DotPromptFrontmatter;

  /** The prompt template content */
  content: string;

  /** Filename without extension */
  filename: string;
}

/**
 * DotPrompt Loader
 * Loads and parses .prompt files with YAML frontmatter
 *
 * File format:
 * ```
 * ---
 * scenario: chat
 * tools:
 *   - docRead
 *   - webSearch
 * config:
 *   temperature: 0.7
 * ---
 * You are AFFiNE AI, a helpful assistant...
 * ```
 */
export class DotPromptLoader {
  private readonly logger = new Logger(DotPromptLoader.name);
  private readonly promptsDir: string;
  private readonly cache = new Map<string, DotPrompt>();

  constructor(promptsDir?: string) {
    this.promptsDir = promptsDir || path.join(__dirname, '../prompts');
    this.logger.log(`DotPrompt directory: ${this.promptsDir}`);
  }

  /**
   * Load a prompt file by name
   * @param name - Prompt name (without .prompt extension)
   * @returns Parsed DotPrompt or null if not found
   */
  async load(name: string): Promise<DotPrompt | null> {
    // Check cache first
    if (this.cache.has(name)) {
      this.logger.debug(`Cache hit for prompt: ${name}`);
      return this.cache.get(name)!;
    }

    // Slugify name to match filesystem (e.g., "Chat With AFFiNE AI" -> "chat-with-affine-ai")
    const filename = name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-:]/g, '')
      .replace(/^-+|-+$/g, '');

    const filepath = path.join(this.promptsDir, `${filename}.prompt`);

    try {
      const content = await fs.readFile(filepath, 'utf-8');
      const parsed = this.parse(content, name);
      this.cache.set(name, parsed);
      this.logger.log(`✅ Loaded dotprompt: ${name} (from ${filename}.prompt)`);
      return parsed;
    } catch (e) {
      if ((e as any).code === 'ENOENT') {
        this.logger.debug(`Dotprompt file not found: ${filename}.prompt`);
        return null; // File not found
      }
      this.logger.error(`Error loading dotprompt ${name}:`, e);
      throw e;
    }
  }

  /**
   * Parse dotprompt file content
   * @param content - Raw file content
   * @param filename - Filename for reference
   * @returns Parsed DotPrompt
   */
  private parse(content: string, filename: string): DotPrompt {
    // Split on --- delimiters
    const parts = content.split(/^---$/m);

    if (parts.length < 3) {
      // No frontmatter, treat entire content as template
      this.logger.debug(
        `No frontmatter found in ${filename}, using entire content as template`
      );
      return {
        frontmatter: {},
        content: content.trim(),
        filename,
      };
    }

    const frontmatterStr = parts[1].trim();
    const template = parts.slice(2).join('---').trim();

    let frontmatter: DotPromptFrontmatter = {};
    try {
      frontmatter = yaml.parse(frontmatterStr) as DotPromptFrontmatter;
    } catch (e) {
      this.logger.error(`Failed to parse YAML frontmatter in ${filename}:`, e);
      throw new Error(
        `Invalid YAML frontmatter in ${filename}.prompt: ${(e as Error).message}`
      );
    }

    return {
      frontmatter,
      content: template,
      filename,
    };
  }

  /**
   * Clear the cache
   * Useful for development/testing
   */
  clearCache() {
    this.cache.clear();
    this.logger.debug('DotPrompt cache cleared');
  }

  /**
   * List all available .prompt files
   * @returns Array of prompt names (without .prompt extension)
   */
  async listAvailable(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.promptsDir);
      return files
        .filter(f => f.endsWith('.prompt'))
        .map(f => f.replace(/\.prompt$/, ''));
    } catch (e) {
      if ((e as any).code === 'ENOENT') {
        this.logger.warn(`Prompts directory not found: ${this.promptsDir}`);
        return [];
      }
      throw e;
    }
  }

  /**
   * Convert dotprompt content to PromptMessage array
   * Simple implementation: treats entire content as system message
   * Can be enhanced to support multi-message templates
   */
  parsePromptTemplate(content: string): PromptMessage[] {
    return [
      {
        role: 'system',
        content: content.trim(),
      },
    ];
  }
}
