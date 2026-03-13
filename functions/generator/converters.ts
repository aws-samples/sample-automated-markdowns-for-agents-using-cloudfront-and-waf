import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { MARKDOWN_CONTENT_TYPE, DEFAULT_FORMAT } from '../../lib/constants';

export interface ConvertResult {
  content: string;
  metadata: Record<string, string>;
}

export interface Converter {
  contentType: string;
  convert(html: string): ConvertResult;
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});
turndown.use(gfm);

function extractHeadMeta(html: string): Record<string, string> {
  const meta: Record<string, string> = {};

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch?.[1]?.trim()) meta.title = titleMatch[1].trim();

  const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)
    || html.match(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i);
  if (descMatch?.[1]?.trim()) meta.description = descMatch[1].trim();

  const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']*)["']/i)
    || html.match(/<meta\s+content=["']([^"']*)["']\s+property=["']og:image["']/i);
  if (ogImageMatch?.[1]?.trim()) meta.image = ogImageMatch[1].trim();

  const canonicalMatch = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']*)["']/i)
    || html.match(/<link\s+href=["']([^"']*)["']\s+rel=["']canonical["']/i);
  if (canonicalMatch?.[1]?.trim()) meta.source_url = canonicalMatch[1].trim();

  return meta;
}

function buildFrontmatter(meta: Record<string, string>): string {
  if (Object.keys(meta).length === 0) return '';
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

const markdownConverter: Converter = {
  contentType: MARKDOWN_CONTENT_TYPE,
  convert(html: string): ConvertResult {
    const headMeta = extractHeadMeta(html);
    const markdown = turndown.turndown(html);
    const frontmatter = buildFrontmatter(headMeta);
    const content = frontmatter + markdown;
    const tokens = String(Math.ceil(content.length / 4));

    return {
      content,
      metadata: { tokens, ...headMeta },
    };
  },
};

export const converters: Record<string, Converter> = {
  [DEFAULT_FORMAT]: markdownConverter,
};
