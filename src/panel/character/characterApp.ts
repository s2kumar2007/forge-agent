import { type CharacterState, type CharacterMode, mapEventToState, getStateAriaAnnouncement, redactCharacterSpeech } from './characterState';
import { renderCharacterSvg } from './characterSvg';
import { ForgeCharacter3D } from './character3d';

declare global {
  interface Window {
    __FORGE_INITIAL_CONFIG__?: {
      guideCharacter3d?: boolean;
    };
    __FORGE_CHARACTER_APP__?: CharacterApp;
  }
}

export class CharacterApp {
  private mode: CharacterMode = 'Off';
  private state: CharacterState = 'idle';
  private char3d: ForgeCharacter3D | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private svgContainer: HTMLElement | null = null;
  private dock: HTMLElement | null = null;
  private speechBubble: HTMLElement | null = null;
  private ariaLive: HTMLElement | null = null;
  private modeButtons: NodeListOf<HTMLButtonElement> | null = null;
  private bubbleTimeout: number | null = null;

  constructor() {
    this.init();
  }

  public init(): void {
    if (typeof document === 'undefined') return;

    this.canvas = document.getElementById('forge-character-canvas') as HTMLCanvasElement;
    this.svgContainer = document.getElementById('forge-character-svg');
    this.dock = document.getElementById('forge-character-dock');
    this.speechBubble = document.getElementById('character-speech-bubble');
    this.ariaLive = document.getElementById('character-aria-live');
    this.modeButtons = document.querySelectorAll('.character-mode-toggle .mode-btn');

    // Determine initial mode: sessionStorage > config setting (off by default)
    let initialMode: CharacterMode = 'Off';
    try {
      const saved = sessionStorage.getItem('forge.characterMode');
      if (saved === '3D' || saved === '2D' || saved === 'Off') {
        initialMode = saved;
      } else if (window.__FORGE_INITIAL_CONFIG__?.guideCharacter3d) {
        initialMode = '3D';
      }
    } catch {
      if (window.__FORGE_INITIAL_CONFIG__?.guideCharacter3d) {
        initialMode = '3D';
      }
    }

    this.bindEvents();
    this.setMode(initialMode, false);
  }

  private bindEvents(): void {
    // Mode toggle buttons
    if (this.modeButtons) {
      this.modeButtons.forEach((btn: HTMLButtonElement) => {
        btn.addEventListener('click', () => {
          const m = btn.getAttribute('data-mode') as CharacterMode;
          if (m) this.setMode(m, true);
        });
        // Keyboard accessible Space / Enter
        btn.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            const m = btn.getAttribute('data-mode') as CharacterMode;
            if (m) this.setMode(m, true);
          }
        });
      });
    }

    // Input listeners to detect listening / focus
    const input = document.getElementById('input');
    if (input) {
      input.addEventListener('focus', () => {
        if (this.state === 'idle') this.setState('listening');
      });
      input.addEventListener('blur', () => {
        if (this.state === 'listening') this.setState('idle');
      });
    }

    // Webview messages from host
    window.addEventListener('message', (event: MessageEvent<any>) => {
      const m = event.data;
      if (!m || typeof m !== 'object') return;
      this.handleHostMessage(m);
    });

    // Visibility change pauses 3D rendering
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.char3d?.stopAnimation();
      } else if (this.mode === '3D' && this.char3d) {
        this.char3d.startAnimation();
      }
    });

    // Cleanup on window unload
    window.addEventListener('unload', () => {
      this.dispose();
    });
  }

  public handleHostMessage(m: any): void {
    const nextState = mapEventToState(m, this.state);
    let speech: string | undefined;

    if (m.type === 'tool' && m.name) {
      speech = `Running ${m.name}...`;
    } else if (m.type === 'diffPreview' && m.path) {
      speech = `Reviewing diff in ${m.path}`;
    } else if (m.type === 'notice' && m.text) {
      speech = m.text;
    } else if (m.type === 'done') {
      speech = m.status === 'error' ? 'Task failed.' : 'Task complete!';
    }

    this.setState(nextState, speech);
  }

  public setMode(newMode: CharacterMode, persist = true): void {
    this.mode = newMode;
    if (persist) {
      try {
        sessionStorage.setItem('forge.characterMode', newMode);
      } catch {}
    }

    // Update button states
    if (this.modeButtons) {
      this.modeButtons.forEach((btn: HTMLButtonElement) => {
        const isMatch = btn.getAttribute('data-mode') === newMode;
        btn.classList.toggle('active', isMatch);
        btn.setAttribute('aria-checked', isMatch ? 'true' : 'false');
      });
    }

    if (newMode === 'Off') {
      if (this.canvas) this.canvas.style.display = 'none';
      if (this.svgContainer) this.svgContainer.style.display = 'none';
      if (this.speechBubble) this.speechBubble.style.display = 'none';
      this.dock?.classList.add('collapsed');
      this.char3d?.stopAnimation();
      return;
    }

    this.dock?.classList.remove('collapsed');

    if (newMode === '2D') {
      this.char3d?.stopAnimation();
      if (this.canvas) this.canvas.style.display = 'none';
      if (this.svgContainer) {
        this.svgContainer.style.display = 'block';
        this.svgContainer.innerHTML = renderCharacterSvg(this.state);
      }
      return;
    }

    if (newMode === '3D') {
      if (this.svgContainer) this.svgContainer.style.display = 'none';
      if (this.canvas) this.canvas.style.display = 'block';

      if (!this.char3d && this.canvas) {
        try {
          this.char3d = new ForgeCharacter3D({
            canvas: this.canvas,
            width: 160,
            height: 160,
            onFallback: (reason) => {
              console.warn(`[Forge Character] Fallback to 2D: ${reason}`);
              this.setMode('2D', true);
            },
          });
        } catch {
          // Fallback to 2D if WebGL fails during constructor
          this.setMode('2D', true);
          return;
        }
      }

      this.char3d?.setState(this.state);
    }
  }

  public getMode(): CharacterMode {
    return this.mode;
  }

  public getState(): CharacterState {
    return this.state;
  }

  public setState(newState: CharacterState, speechText?: string): void {
    this.state = newState;

    // Update screen-reader announcement
    if (this.ariaLive) {
      this.ariaLive.textContent = getStateAriaAnnouncement(newState);
    }

    // Update active render target
    if (this.mode === '3D' && this.char3d) {
      this.char3d.setState(newState);
    } else if (this.mode === '2D' && this.svgContainer) {
      this.svgContainer.innerHTML = renderCharacterSvg(newState);
    }

    // Optional speech bubble (with secret file redaction)
    if (speechText && this.mode !== 'Off' && this.speechBubble) {
      const scrubbed = redactCharacterSpeech(speechText);
      this.speechBubble.textContent = scrubbed;
      this.speechBubble.style.display = 'block';
      if (this.bubbleTimeout !== null) clearTimeout(this.bubbleTimeout);
      this.bubbleTimeout = window.setTimeout(() => {
        if (this.speechBubble) this.speechBubble.style.display = 'none';
        this.bubbleTimeout = null;
      }, 4000);
    }
  }

  public dispose(): void {
    if (this.bubbleTimeout !== null) {
      clearTimeout(this.bubbleTimeout);
      this.bubbleTimeout = null;
    }
    this.char3d?.dispose();
    this.char3d = null;
  }
}

// Auto-instantiate in browser context
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    window.__FORGE_CHARACTER_APP__ = new CharacterApp();
  });
}
