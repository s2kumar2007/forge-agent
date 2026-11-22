export type CharacterState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'reviewing'
  | 'alert'
  | 'success';

export type CharacterMode = '3D' | '2D' | 'Off';

export interface CharacterStateConfig {
  visorColor: string;
  glowColor: string;
  title: string;
  announcement: string;
}

export const STATE_CONFIGS: Record<CharacterState, CharacterStateConfig> = {
  idle: {
    visorColor: '#00b4d8',
    glowColor: 'rgba(0, 180, 216, 0.6)',
    title: 'Idle',
    announcement: 'Forge is idle and ready',
  },
  listening: {
    visorColor: '#38bdf8',
    glowColor: 'rgba(56, 189, 248, 0.7)',
    title: 'Listening',
    announcement: 'Forge is listening to your request',
  },
  thinking: {
    visorColor: '#f59e0b',
    glowColor: 'rgba(245, 158, 11, 0.7)',
    title: 'Thinking',
    announcement: 'Forge is analyzing and thinking',
  },
  speaking: {
    visorColor: '#818cf8',
    glowColor: 'rgba(129, 140, 248, 0.7)',
    title: 'Speaking',
    announcement: 'Forge is generating a response',
  },
  reviewing: {
    visorColor: '#ea580c',
    glowColor: 'rgba(234, 88, 12, 0.7)',
    title: 'Reviewing',
    announcement: 'Forge is reviewing proposed file changes',
  },
  alert: {
    visorColor: '#ef4444',
    glowColor: 'rgba(239, 68, 68, 0.8)',
    title: 'Alert',
    announcement: 'Forge encountered an issue or warning',
  },
  success: {
    visorColor: '#10b981',
    glowColor: 'rgba(16, 185, 129, 0.8)',
    title: 'Success',
    announcement: 'Forge completed the task successfully',
  },
};

export interface CharacterEvent {
  type: string;
  text?: string;
  name?: string;
  status?: string;
  message?: string;
  value?: boolean;
  confidence?: { tag: string; score: number };
}

/** Redacts secret-like filenames and contents from character speech bubbles */
export function redactCharacterSpeech(text: string): string {
  if (!text) return '';
  const secretPatterns = [
    /\.env(?:\.[a-zA-Z0-9_\-]+)?/gi,
    /[a-zA-Z0-9_\-\./\\]+\.(?:pem|key|p12)\b/gi,
    /\bid_rsa[a-zA-Z0-9_\-\.]*/gi,
    /\bcredentials[a-zA-Z0-9_\-\.]*/gi,
    /\.git[/\\][^\s]*/gi,
    /\.git\b/gi,
  ];
  let scrubbed = text;
  for (const pat of secretPatterns) {
    scrubbed = scrubbed.replace(pat, '[REDACTED_SECRET_FILE]');
  }
  return scrubbed;
}

export function getStateAriaAnnouncement(state: CharacterState): string {
  return STATE_CONFIGS[state]?.announcement ?? `Forge is ${state}`;
}

/** Pure state-transition function mapping run events to character states */
export function mapEventToState(event: CharacterEvent, currentState: CharacterState): CharacterState {
  switch (event.type) {
    case 'tool': {
      const name = (event.name || '').toLowerCase();
      if (name.includes('write') || name.includes('propose') || name.includes('change')) {
        return 'reviewing';
      }
      return 'thinking';
    }

    case 'diffPreview':
      return 'reviewing';

    case 'delta':
      return 'speaking';

    case 'notice': {
      const text = (event.text || '').toLowerCase();
      if (
        text.includes('fallback') ||
        text.includes('unavailable') ||
        text.includes('fail') ||
        text.includes('error') ||
        text.includes('trip') ||
        text.includes('breaker') ||
        text.includes('stall') ||
        text.includes('timeout') ||
        text.includes('warn')
      ) {
        return 'alert';
      }
      if (text.includes('success') || text.includes('passed') || text.includes('applied')) {
        return 'success';
      }
      return currentState;
    }

    case 'done': {
      if (event.status === 'error') {
        return 'alert';
      }
      if (event.status === 'cancelled') {
        return 'idle';
      }
      return 'success';
    }

    case 'busy': {
      if (event.value === true) {
        if (currentState === 'idle' || currentState === 'listening') {
          return 'thinking';
        }
        return currentState;
      } else {
        if (currentState === 'alert' || currentState === 'reviewing' || currentState === 'success') {
          return currentState;
        }
        return 'idle';
      }
    }

    case 'listening':
    case 'inputFocus':
    case 'micActive':
      return 'listening';

    case 'inputBlur':
    case 'reset':
      return 'idle';

    default:
      return currentState;
  }
}
