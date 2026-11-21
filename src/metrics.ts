export interface ToolCallMetric {
  name: string;
  durationMs: number;
}

export interface RunMetrics {
  startTime: number;
  endTime: number;
  totalTimeMs: number;
  timeToFirstTokenMs?: number;
  toolCalls: ToolCallMetric[];
  modelTurns: number;
  estimatedTokensIn: number;
  estimatedTokensOut: number;
  agentAnswered?: string;
}

export class RunMetricsCollector {
  private startTime: number;
  private endTime?: number;
  private firstTokenTime?: number;
  private activeTool?: { name: string; start: number };
  private toolCalls: ToolCallMetric[] = [];
  private modelTurns = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  private agentAnswered?: string;

  constructor(private now: () => number = Date.now) {
    this.startTime = this.now();
  }

  recordInput(text: string): void {
    if (!text) return;
    this.tokensIn += Math.ceil(text.length / 4);
  }

  recordFirstToken(): void {
    if (this.firstTokenTime === undefined) {
      this.firstTokenTime = this.now();
    }
  }

  recordTextDelta(delta: string): void {
    if (!delta) return;
    this.recordFirstToken();
    this.tokensOut += Math.ceil(delta.length / 4);
  }

  recordModelTurn(): void {
    this.modelTurns++;
  }

  recordToolStart(name: string): void {
    if (this.activeTool) {
      this.recordToolEnd();
    }
    this.activeTool = { name, start: this.now() };
  }

  recordToolEnd(name?: string): void {
    if (this.activeTool) {
      const durationMs = Math.max(0, this.now() - this.activeTool.start);
      this.toolCalls.push({ name: name ?? this.activeTool.name, durationMs });
      this.activeTool = undefined;
    }
  }

  setAgentAnswered(agent: string): void {
    this.agentAnswered = agent;
  }

  finish(): RunMetrics {
    if (this.activeTool) {
      this.recordToolEnd();
    }
    this.endTime = this.now();
    return {
      startTime: this.startTime,
      endTime: this.endTime,
      totalTimeMs: Math.max(0, this.endTime - this.startTime),
      timeToFirstTokenMs: this.firstTokenTime !== undefined ? Math.max(0, this.firstTokenTime - this.startTime) : undefined,
      toolCalls: [...this.toolCalls],
      modelTurns: this.modelTurns,
      estimatedTokensIn: this.tokensIn,
      estimatedTokensOut: this.tokensOut,
      agentAnswered: this.agentAnswered,
    };
  }

  formatSummary(metrics?: RunMetrics): string {
    const m = metrics ?? this.finish();
    const ttft = m.timeToFirstTokenMs !== undefined ? `${m.timeToFirstTokenMs}ms` : 'n/a';
    const total = `${(m.totalTimeMs / 1000).toFixed(2)}s`;
    const toolDetails = m.toolCalls.length > 0
      ? m.toolCalls.map((t) => `${t.name}: ${t.durationMs}ms`).join(', ')
      : 'none';
    return `[Metrics] Agent: ${m.agentAnswered ?? 'unknown'} | Total: ${total} | TTFT: ${ttft} | Turns: ${m.modelTurns} | Tokens: ~${m.estimatedTokensIn} in / ~${m.estimatedTokensOut} out | Tools: ${toolDetails}`;
  }
}
