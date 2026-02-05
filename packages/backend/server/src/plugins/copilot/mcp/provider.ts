import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Injectable } from '@nestjs/common';
import { pick } from 'lodash-es';
import {
  applyUpdate,
  Array as YArray,
  Doc as YDoc,
  encodeStateAsUpdate,
  Map as YMap,
  Text as YText,
} from 'yjs';
import z from 'zod/v3';

import {
  DocReader,
  DocWriter,
  PgWorkspaceDocStorageAdapter,
} from '../../../core/doc';
import { AccessController } from '../../../core/permission';
import { readAllBlocksFromDocSnapshot } from '../../../core/utils/blocksuite';
import { WorkspaceService } from '../../../core/workspaces';
import { clearEmbeddingChunk } from '../../../models';
import { Models } from '../../../models';
import { IndexerService } from '../../indexer';
import { CopilotContextService } from '../context';
import { BLOCK_SCHEMAS } from './schemas';

@Injectable()
export class WorkspaceMcpProvider {
  constructor(
    private readonly ac: AccessController,
    private readonly reader: DocReader,
    private readonly writer: DocWriter,
    private readonly context: CopilotContextService,
    private readonly indexer: IndexerService,
    private readonly storage: PgWorkspaceDocStorageAdapter,
    private readonly models: Models,
    private readonly workspaceService: WorkspaceService
  ) {}

  async for(userId: string, workspaceId: string) {
    await this.ac.user(userId).workspace(workspaceId).assert('Workspace.Read');

    const server = new McpServer({
      name: `AFFiNE MCP Server for Workspace ${workspaceId}`,
      version: '1.0.0',
    });

    server.registerTool(
      'read_document',
      {
        title: 'Read Document',
        description: 'Read a document with given ID',
        inputSchema: z.object({
          docId: z.string(),
        }),
      },
      async ({ docId }) => {
        const notFoundError: CallToolResult = {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Doc with id ${docId} not found.`,
            },
          ],
        };

        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Read');

        if (!accessible) {
          return notFoundError;
        }

        const content = await this.reader.getDocMarkdown(
          workspaceId,
          docId,
          false
        );

        if (!content) {
          return notFoundError;
        }

        return {
          content: [
            {
              type: 'text',
              text: content.markdown,
            },
          ],
        } as const;
      }
    );

    server.registerTool(
      'semantic_search',
      {
        title: 'Semantic Search',
        description:
          'Retrieve conceptually related passages by performing vector-based semantic similarity search across embedded documents; use this tool only when exact keyword search fails or the user explicitly needs meaning-level matches (e.g., paraphrases, synonyms, broader concepts, recent documents).',
        inputSchema: z.object({
          query: z.string(),
        }),
      },
      async ({ query }, req) => {
        query = query.trim();
        if (!query) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'Query is required for semantic search.',
              },
            ],
          };
        }

        const chunks = await this.context.matchWorkspaceDocs(
          workspaceId,
          query,
          5,
          req.signal
        );

        const docs = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .docs(
            chunks.filter(c => 'docId' in c),
            'Doc.Read'
          );

        return {
          content: docs.map(doc => ({
            type: 'text',
            text: clearEmbeddingChunk(doc).content,
          })),
        } as const;
      }
    );

    server.registerTool(
      'keyword_search',
      {
        title: 'Keyword Search',
        description:
          'Fuzzy search all workspace documents for the exact keyword or phrase supplied and return passages ranked by textual match. Use this tool by default whenever a straightforward term-based or keyword-base lookup is sufficient.',
        inputSchema: z.object({
          query: z.string(),
        }),
      },
      async ({ query }) => {
        query = query.trim();
        if (!query) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'Query is required for keyword search.',
              },
            ],
          };
        }

        let docs = await this.indexer.searchDocsByKeyword(workspaceId, query);
        docs = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .docs(docs, 'Doc.Read');

        return {
          content: docs.map(doc => ({
            type: 'text',
            text: JSON.stringify(pick(doc, 'docId', 'title', 'createdAt')),
          })),
        } as const;
      }
    );

    // Write tools - create and update documents
    server.registerTool(
      'create_document',
      {
        title: 'Create Document',
        description:
          'Create a new document in the workspace with the given title and markdown content. Returns the ID of the created document. This tool not support insert or update database block and image yet.',
        inputSchema: z.object({
          title: z.string().min(1).describe('The title of the new document'),
          content: z
            .string()
            .describe('The markdown content for the document body'),
        }),
      },
      async ({ title, content }) => {
        try {
          await this.ac
            .user(userId)
            .workspace(workspaceId)
            .assert('Workspace.CreateDoc');

          const sanitizedTitle = title.replace(/[\r\n]+/g, ' ').trim();
          if (!sanitizedTitle) throw new Error('Title cannot be empty');
          const strippedContent = content.replace(
            /^[ \t]{0,3}#\s+[^\n]*#*\s*\n*/,
            ''
          );

          const result = await this.writer.createDoc(
            workspaceId,
            sanitizedTitle,
            strippedContent,
            userId
          );

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  docId: result.docId,
                  message: `Document "${title}" created successfully`,
                }),
              },
            ],
          } as const;
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Failed to create document: ${error instanceof Error ? error.message : 'Unknown error'}`,
              },
            ],
          };
        }
      }
    );

    server.registerTool(
      'update_document',
      {
        title: 'Update Document',
        description:
          'Update an existing document with new markdown content (body only). Uses structural diffing to apply minimal changes, preserving document history and enabling real-time collaboration. This does NOT update the document title. This tool not support insert or update database block and image yet.',
        inputSchema: z.object({
          docId: z.string().describe('The ID of the document to update'),
          content: z
            .string()
            .describe(
              'The complete new markdown content for the document body (do NOT include a title H1)'
            ),
        }),
      },
      async ({ docId, content }) => {
        const notFoundError: CallToolResult = {
          isError: true,
          content: [{ type: 'text', text: `Doc with id ${docId} not found.` }],
        };

        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Update');
        if (!accessible) return notFoundError;

        try {
          await this.writer.updateDoc(workspaceId, docId, content, userId);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  docId,
                  message: `Document updated successfully`,
                }),
              },
            ],
          } as const;
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Failed to update document: ${error instanceof Error ? error.message : 'Unknown error'}`,
              },
            ],
          };
        }
      }
    );

    server.registerTool(
      'update_document_meta',
      {
        title: 'Update Document Metadata',
        description: 'Update document metadata (currently title only).',
        inputSchema: z.object({
          docId: z.string().describe('The ID of the document to update'),
          title: z.string().min(1).describe('The new document title'),
        }),
      },
      async ({ docId, title }) => {
        const notFoundError: CallToolResult = {
          isError: true,
          content: [{ type: 'text', text: `Doc with id ${docId} not found.` }],
        };

        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Update');
        if (!accessible) return notFoundError;

        try {
          const sanitizedTitle = title.replace(/[\r\n]+/g, ' ').trim();
          if (!sanitizedTitle) throw new Error('Title cannot be empty');

          await this.writer.updateDocMeta(
            workspaceId,
            docId,
            { title: sanitizedTitle },
            userId
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  docId,
                  message: `Document title updated successfully`,
                }),
              },
            ],
          } as const;
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Failed to update document metadata: ${error instanceof Error ? error.message : 'Unknown error'}`,
              },
            ],
          };
        }
      }
    );

    server.registerTool(
      'append_content',
      {
        title: 'Append Content',
        description: 'Append text content to the end of a document.',
        inputSchema: z.object({ docId: z.string(), content: z.string() }),
      },
      async ({ docId, content }) => {
        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Update');
        if (!accessible)
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Permission denied to write to doc ${docId}.`,
              },
            ],
          };

        const docRecord = await this.storage.getDoc(workspaceId, docId);
        if (!docRecord)
          return {
            isError: true,
            content: [
              { type: 'text', text: `Doc with id ${docId} not found.` },
            ],
          };

        const doc = new YDoc();
        applyUpdate(doc, docRecord.bin);
        const blocks = doc.getMap('blocks');
        let noteBlockId: string | undefined;

        for (const block of blocks.values()) {
          const flavour = (block as YMap<any>).get('sys:flavour');
          if (flavour === 'affine:note')
            noteBlockId = (block as YMap<any>).get('sys:id');
        }

        if (!noteBlockId)
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Structure error: No note block found in doc ${docId}.`,
              },
            ],
          };

        const newBlockId = randomUUID();
        const newBlock = new YMap();
        newBlock.set('sys:id', newBlockId);
        newBlock.set('sys:flavour', 'affine:paragraph');
        newBlock.set('prop:type', 'text');
        newBlock.set('sys:children', new YArray());
        const text = new YText(content);
        newBlock.set('prop:text', text);

        blocks.set(newBlockId, newBlock);

        const noteBlock = blocks.get(noteBlockId) as YMap<any>;
        const children = noteBlock.get('sys:children') as YArray<string>;
        children.push([newBlockId]);

        const update = encodeStateAsUpdate(doc);
        await this.storage.pushDocUpdates(workspaceId, docId, [update]);

        return {
          content: [{ type: 'text', text: 'Content appended successfully.' }],
        };
      }
    );

    server.registerTool(
      'append_blocks',
      {
        title: 'Append Blocks',
        description:
          'Append structured blocks to a specific parent block in a document. Supports nested structures.',
        inputSchema: z.object({
          docId: z.string(),
          parentId: z
            .string()
            .describe(
              'The ID of the parent block to append to (e.g. the note block ID)'
            ),
          blocks: z.array(
            z.object({
              flavour: z.string(),
              props: z.record(z.any()).optional(),
              children: z
                .array(z.any())
                .optional()
                .describe('Recursive array of child blocks'),
            })
          ),
        }),
      },
      async ({ docId, parentId, blocks: inputBlocks }) => {
        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Update');
        if (!accessible)
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Permission denied to update doc ${docId}.`,
              },
            ],
          };

        const docRecord = await this.storage.getDoc(workspaceId, docId);
        if (!docRecord)
          return {
            isError: true,
            content: [
              { type: 'text', text: `Doc with id ${docId} not found.` },
            ],
          };

        const doc = new YDoc();
        applyUpdate(doc, docRecord.bin);
        const yBlocksMap = doc.getMap('blocks');

        if (!yBlocksMap.has(parentId))
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Parent block ${parentId} not found in doc ${docId}. Use get_document_blocks to find valid parent IDs.`,
              },
            ],
          };

        const parentBlock = yBlocksMap.get(parentId) as YMap<any>;
        const parentChildren = parentBlock.get(
          'sys:children'
        ) as YArray<string>;

        const createBlock = (blockDef: any): string => {
          const newId = randomUUID();
          const newBlock = new YMap();
          newBlock.set('sys:id', newId);
          newBlock.set('sys:flavour', blockDef.flavour);

          if (blockDef.props) {
            for (const [key, value] of Object.entries(blockDef.props)) {
              if (key === 'text' && typeof value === 'string') {
                newBlock.set(`prop:${key}`, new YText(value));
              } else {
                newBlock.set(`prop:${key}`, value);
              }
            }
          }

          const newChildren = new YArray();
          if (blockDef.children && Array.isArray(blockDef.children)) {
            for (const childDef of blockDef.children) {
              const childId = createBlock(childDef);
              newChildren.push([childId]);
            }
          }
          newBlock.set('sys:children', newChildren);
          yBlocksMap.set(newId, newBlock);
          return newId;
        };

        const addedIds: string[] = [];
        try {
          for (const blockDef of inputBlocks) {
            const newId = createBlock(blockDef);
            parentChildren.push([newId]);
            addedIds.push(newId);
          }
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Failed to create blocks: ${(e as Error).message}`,
              },
            ],
          };
        }

        const update = encodeStateAsUpdate(doc);
        await this.storage.pushDocUpdates(workspaceId, docId, [update]);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                addedBlockIds: addedIds,
              }),
            },
          ],
        };
      }
    );

    server.registerTool(
      'delete_document',
      {
        title: 'Delete Document',
        description: 'Permanently delete a document.',
        inputSchema: z.object({
          docId: z.string(),
        }),
      },
      async ({ docId }) => {
        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Delete');

        if (!accessible)
          return {
            isError: true,
            content: [
              { type: 'text', text: 'Permission denied to delete doc.' },
            ],
          };

        await this.storage.deleteDoc(workspaceId, docId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ id: docId, status: 'deleted' }),
            },
          ],
        };
      }
    );
    // End of write tools

    server.registerTool(
      'get_block_schema',
      {
        title: 'Get Block Schema',
        description: 'Get the schema definition for a specific block flavour.',
        inputSchema: z.object({ flavour: z.string().optional() }),
      },
      async ({ flavour }) => {
        if (flavour) {
          const schema = BLOCK_SCHEMAS[flavour];
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(schema || 'Not found', null, 2),
              },
            ],
          };
        }
        return {
          content: [
            { type: 'text', text: JSON.stringify(BLOCK_SCHEMAS, null, 2) },
          ],
        };
      }
    );

    server.registerTool(
      'get_document_blocks',
      {
        title: 'Get Document Blocks',
        description: 'Read a document as a structured JSON tree.',
        inputSchema: z.object({ docId: z.string() }),
      },
      async ({ docId }) => {
        const docRecord = await this.storage.getDoc(workspaceId, docId);
        if (!docRecord)
          return {
            isError: true,
            content: [{ type: 'text', text: 'Not found' }],
          };
        try {
          const result = await readAllBlocksFromDocSnapshot(
            docId,
            docRecord.bin
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (e) {
          return {
            isError: true,
            content: [{ type: 'text', text: (e as Error).message }],
          };
        }
      }
    );

    server.registerTool(
      'list_documents',
      {
        title: 'List Documents',
        description:
          'Browse workspace documents with pagination and sorting. Useful for discovering content.',
        inputSchema: z.object({
          limit: z.number().optional().describe('Top N results (default 50)'),
          offset: z.number().optional().describe('Skip N results'),
          sortBy: z.enum(['created', 'updated']).optional().default('updated'),
          order: z.enum(['asc', 'desc']).optional().default('desc'),
        }),
      },
      async ({ limit = 50, offset = 0, sortBy }) => {
        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .can('Workspace.Read');
        if (!accessible)
          return {
            isError: true,
            content: [
              { type: 'text', text: 'Permission denied to read workspace.' },
            ],
          };

        const pagination = {
          take: limit,
          skip: offset,
          first: limit,
          offset: offset,
        };
        let result;
        if (sortBy === 'created') {
          result = await this.models.doc.paginateDocInfo(
            workspaceId,
            pagination
          );
        } else {
          result = await this.models.doc.paginateDocInfoByUpdatedAt(
            workspaceId,
            pagination
          );
        }

        const [total, docs] = result;
        const mappedDocs = docs.map(d => ({
          id: d.docId,
          title: d.title || 'Untitled',
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          public: d.public,
          mode: d.mode,
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ total, documents: mappedDocs }, null, 2),
            },
          ],
        };
      }
    );

    server.registerTool(
      'get_document_history',
      {
        title: 'Get Document History',
        description: 'Retrieve version history timestamps for a document.',
        inputSchema: z.object({
          docId: z.string(),
          limit: z.number().optional().default(10),
        }),
      },
      async ({ docId, limit }) => {
        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Read');
        if (!accessible)
          return {
            isError: true,
            content: [{ type: 'text', text: 'Permission denied.' }],
          };

        const history = await this.storage.listDocHistories(
          workspaceId,
          docId,
          { limit }
        );

        return {
          content: [{ type: 'text', text: JSON.stringify(history, null, 2) }],
        };
      }
    );

    server.registerTool(
      'get_workspace_meta',
      {
        title: 'Get Workspace Metadata',
        description: 'Get basic workspace information.',
        inputSchema: z.object({}),
      },
      async () => {
        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .can('Workspace.Read');
        if (!accessible)
          return {
            isError: true,
            content: [{ type: 'text', text: 'Permission denied.' }],
          };

        const info = await this.workspaceService.getWorkspaceInfo(workspaceId);

        return {
          content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
        };
      }
    );

    return server;
  }
}
