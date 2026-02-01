import z from 'zod/v3';

const BaseBlockSchema = z.object({
  flavour: z.string(),
  props: z.record(z.any()).optional(),
  children: z.array(z.string()).optional(),
});

export const BLOCK_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'affine:page': BaseBlockSchema.extend({
    props: z
      .object({
        title: z.any().optional(), // YText
      })
      .passthrough(),
  }),
  'affine:note': BaseBlockSchema,
  'affine:paragraph': BaseBlockSchema.extend({
    props: z
      .object({
        text: z.any().optional(), // YText
        type: z
          .enum(['text', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'quote'])
          .optional(),
      })
      .passthrough(),
  }),
  'affine:list': BaseBlockSchema.extend({
    props: z
      .object({
        text: z.any().optional(),
        type: z.enum(['bulleted', 'numbered', 'todo', 'toggle']).optional(),
        checked: z.boolean().optional(),
      })
      .passthrough(),
  }),
  'affine:code': BaseBlockSchema.extend({
    props: z
      .object({
        language: z.string().optional(),
        text: z.any().optional(),
      })
      .passthrough(),
  }),
  'affine:image': BaseBlockSchema,
  'affine:attachment': BaseBlockSchema,
  'affine:bookmark': BaseBlockSchema,
  'affine:surface': BaseBlockSchema,
  'affine:frame': BaseBlockSchema,
  'affine:divider': BaseBlockSchema,
  'affine:database': BaseBlockSchema,
};
