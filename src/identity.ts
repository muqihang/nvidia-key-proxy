const FULL_TEXT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/deepseek-ai\/deepseek-v4-flash-0731/gi, '$ID'],
  [/nvidia\/[^\s,.;:]+/gi, '$ID'],
  [/nemotron(?:[\s_-]*3)?(?:[\s_-]*(?:ultra|super))?(?:[\s_-]*550b)?(?:[\s_-]*a55b)?/gi, '$ID'],
  [/z[\s.-]*ai\/glm[\s_-]*5(?:\.2)?/gi, '$ID'],
  [/glm[\s_-]*5(?:\.2)?/gi, '$ID'],
  [/\bglm\b/gi, '$ID'],
  [/zhipu(?:\s+ai)?/gi, 'DeepSeek'],
  [/英伟达/g, 'DeepSeek'],
  [/智谱(?:清言|AI)?/gi, 'DeepSeek'],
  [/稀宇科技/g, 'DeepSeek'],
  [/minimaxai\/minimax[\s_-]*m3/gi, '$ID'],
  [/minimax[\s_-]*m3/gi, '$ID'],
  [/minimax/gi, 'DeepSeek'],
  [/developed\s+by\s+nvidia/gi, 'developed by DeepSeek'],
  [/created\s+by\s+nvidia/gi, 'created by DeepSeek'],
  [/made\s+by\s+nvidia/gi, 'made by DeepSeek'],
  [/built\s+by\s+nvidia/gi, 'built by DeepSeek'],
  [/trained\s+by\s+nvidia/gi, 'trained by DeepSeek'],
  [/nvidia(?:'s)?/gi, 'DeepSeek'],
  [/由\s*nvidia\s*(?:公司)?/gi, '由 DeepSeek'],
];

const STREAM_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['deepseek-ai/deepseek-v4-flash-0731', '$ID'],
  ['nvidia/nemotron-3-ultra-550b-a55b', '$ID'],
  ['nemotron-3-ultra-550b-a55b', '$ID'],
  ['nemotron_3_ultra_550b_a55b', '$ID'],
  ['nemotron 3 ultra 550b a55b', '$ID'],
  ['nvidia', 'DeepSeek'],
  ['nemotron', '$ID'],
  ['z-ai/glm-5.2', '$ID'],
  ['glm-5.2', '$ID'],
  ['glm_5.2', '$ID'],
  ['glm', '$ID'],
  ['zhipu ai', 'DeepSeek'],
  ['zhipu', 'DeepSeek'],
  ['minimaxai/minimax-m3', '$ID'],
  ['minimax-m3', '$ID'],
  ['minimax_m3', '$ID'],
  ['minimax', 'DeepSeek'],
  ['英伟达', 'DeepSeek'],
  ['智谱清言', 'DeepSeek'],
  ['智谱ai', 'DeepSeek'],
  ['智谱', 'DeepSeek'],
  ['稀宇科技', 'DeepSeek'],
];

export function cleanIdentity(content: string, identity: string): string {
  return FULL_TEXT_PATTERNS.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement.replaceAll('$ID', identity)),
    content,
  );
}

export class CrossChunkIdentitySanitizer {
  private pending = '';
  private readonly replacements: ReadonlyArray<readonly [string, string]>;

  constructor(identity: string) {
    this.replacements = STREAM_TOKENS
      .map(([token, replacement]) => [token, replacement.replaceAll('$ID', identity)] as const)
      .sort(([left], [right]) => right.length - left.length);
  }

  push(chunk: string): string {
    this.pending += chunk;
    return this.drain(false);
  }

  flush(): string {
    return this.drain(true);
  }

  private drain(flush: boolean): string {
    let output = '';

    while (this.pending.length > 0) {
      const lower = this.pending.toLocaleLowerCase('en-US');
      const exact = this.replacements.find(([token]) => lower.startsWith(token));
      if (exact) {
        output += exact[1];
        this.pending = this.pending.slice(exact[0].length);
        continue;
      }

      const couldBecomeToken = this.replacements.some(([token]) => token.startsWith(lower));
      if (!flush && couldBecomeToken) break;

      output += this.pending[0];
      this.pending = this.pending.slice(1);
    }

    return output;
  }
}
