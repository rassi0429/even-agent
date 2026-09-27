import { win32 } from 'node:path';
type Value = Record<string, unknown>;
const object = (value: unknown): Value =>
  value && typeof value === 'object' ? (value as Value) : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');

// Only a short user-visible excerpt leaves the collector; never tool arguments/output.
export function activityText(value: unknown): string | undefined {
  const clean = text(value)
    .slice(0, 4000)
    // eslint-disable-next-line no-control-regex -- Strip ANSI terminal escapes from display excerpts.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(
      /\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g,
      '[redacted]',
    )
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(
      /\b([\w-]*(?:token|secret|password|api[_-]?key)[\w-]*)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      '$1=[redacted]',
    )
    .replace(/https?:\/\/\S+/g, '[URL]')
    // eslint-disable-next-line no-control-regex -- Native labels must not contain terminal/bidi controls.
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? [...clean].slice(0, 160).join('') : undefined;
}
const filename = (value: unknown) =>
  activityText(win32.basename(text(value).replaceAll('/', '\\')));
export function codexActivity(item: Value): string | undefined {
  switch (item.type) {
    case 'agentMessage':
      return ['commentary', 'final'].includes(text(item.phase))
        ? activityText(item.text)
        : undefined;
    case 'commandExecution':
      return item.status === 'completed'
        ? 'コマンド実行完了'
        : 'コマンド実行中';
    case 'fileChange':
      return activityText(
        `ファイル編集${filename(item.path) ? ': ' + filename(item.path) : ''}`,
      );
    case 'webSearch':
      return 'Web検索';
    case 'imageView':
      return '画像を確認';
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return activityText(`ツール: ${text(item.tool) || '呼び出し'}`);
    default:
      return undefined;
  }
}
export function claudeActivity(message: Value): string | undefined {
  const blocks = Array.isArray(message.content)
    ? message.content.map(object)
    : [];
  for (const block of blocks.toReversed()) {
    if (block.type === 'text') {
      const excerpt = activityText(block.text);
      if (excerpt) return excerpt;
    }
    if (block.type === 'tool_use') {
      const input = object(block.input);
      const name = text(block.name);
      const labels: Record<string, string> = {
        Read: 'ファイル読取',
        Edit: 'ファイル編集',
        Write: 'ファイル書込',
      };
      if (labels[name])
        return activityText(
          `${labels[name]}${filename(input.file_path) ? ': ' + filename(input.file_path) : ''}`,
        );
      if (name === 'Bash')
        return activityText(input.description) || 'コマンド実行';
      return activityText(`ツール: ${name || '呼び出し'}`);
    }
  }
  return typeof message.content === 'string'
    ? activityText(message.content)
    : undefined;
}
