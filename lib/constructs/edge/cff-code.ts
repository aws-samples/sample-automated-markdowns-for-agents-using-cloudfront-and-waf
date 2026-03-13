import * as fs from 'fs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

export function buildCffCode(
  filePath: string,
  replacements: Record<string, string>,
): cloudfront.FunctionCode {
  let source = fs.readFileSync(filePath, 'utf-8');

  for (const [key, value] of Object.entries(replacements)) {
    source = source.replaceAll(`{{${key}}}`, value);
  }

  const unreplaced = source.match(/\{\{[A-Z_]+\}\}/g);
  if (unreplaced) {
    throw new Error(
      `Unreplaced placeholders in ${filePath}: ${unreplaced.join(', ')}`,
    );
  }

  return cloudfront.FunctionCode.fromInline(source);
}
