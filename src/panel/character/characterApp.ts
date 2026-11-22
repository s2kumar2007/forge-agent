import {
  type CharacterState,
  type CharacterMode,
  mapEventToState,
  getStateAriaAnnouncement,
  redactCharacterSpeech,
} from './characterState';
import { renderCharacterSvg } from './characterSvg';
import { ForgeCharacter3D } from './character3d';
import { type ForgeThemeMode, type ResolvedTheme, resolveTheme } from './theme';

declare global {
  interface Window {
    __FORGE_INITIAL_CONFIG__?: {
      guideCharacter3d?: boolean;
      panelTheme?: string;
    };
    __FORGE_CHARACTER_APP__?: CharacterApp;
    vscode?: {
      postMessage: (msg: any) => void;
      getState: () => any;
      setState: (state: any) => void;
    };
  }
}

export class CharacterApp {
  private mode: CharacterMode = 'Off';
  private state: CharacterState = 'idle';
  private themeMode: ForgeThemeMode = 'auto';
  private resolvedTheme: ResolvedTheme = 'dark';
  private char3d: ForgeCharacter3D | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private svgContainer: HTMLElement | null = null;
  private dock: HTMLElement | null = null;
  private speechBubble: HTMLElement | null = null;
  private ariaLive: HTMLElement | null = null;
  private modeButtons: NodeListOf<HTMLButtonElement> | null = null;
  private themeButtons: NodeListOf<HTMLButtonElement> | null = null;
  private themeHcNotice: HTMLElement | null = null;
  private bubbleTimeout: number | null = null;
  private bodyObserver: MutationObserver | null = null;

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
    this.themeButtons = document.querySelectorAll('.theme-switch .theme-btn');
    this.themeHcNotice = document.getElementById('theme-high-contrast-notice');

    // Determine initial character mode: sessionStorage > '3D'
    let initialMode: CharacterMode = '3D';
    try {
      const saved = sessionStorage.getItem('forge.characterMode');
      if (saved === '3D' || saved === 'Off') {
        initialMode = saved;
      }
    } catch {}

    // Determine initial theme mode: webview state > sessionStorage > setting > 'auto'
    let initialTheme: ForgeThemeMode = 'auto';
    try {
      const vsState = window.vscode?.getState();
      const savedTheme = vsState?.themeMode || sessionStorage.getItem('forge.themeMode');
      if (savedTheme === 'auto' || savedTheme === 'light' || savedTheme === 'dark') {
        initialTheme = savedTheme;
      } else if (window.__FORGE_INITIAL_CONFIG__?.panelTheme) {
        const t = window.__FORGE_INITIAL_CONFIG__.panelTheme;
        if (t === 'light' || t === 'dark') initialTheme = t;
      }
    } catch {}

    this.bindEvents();
    this.setThemeMode(initialTheme, false);
    this.setMode(initialMode, false);
  }

  private bindEvents(): void {
    // Mascot settings dropdown menu
    const menuBtn = document.getElementById('mascot-menu-btn');
    const menuDropdown = document.getElementById('mascot-menu-dropdown');
    if (menuBtn && menuDropdown) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = menuDropdown.style.display === 'block';
        menuDropdown.style.display = isOpen ? 'none' : 'block';
        menuBtn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
      });
      document.addEventListener('click', (e) => {
        if (!menuDropdown.contains(e.target as Node) && e.target !== menuBtn) {
          menuDropdown.style.display = 'none';
          menuBtn.setAttribute('aria-expanded', 'false');
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && menuDropdown.style.display === 'block') {
          menuDropdown.style.display = 'none';
          menuBtn.setAttribute('aria-expanded', 'false');
          menuBtn.focus();
        }
      });
    }

    // Mode toggle buttons (3D / 2D / Off)
    if (this.modeButtons) {
      this.modeButtons.forEach((btn: HTMLButtonElement) => {
        btn.addEventListener('click', () => {
          const m = btn.getAttribute('data-mode') as CharacterMode;
          if (m) this.setMode(m, true);
        });
        btn.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            const m = btn.getAttribute('data-mode') as CharacterMode;
            if (m) this.setMode(m, true);
          }
        });
      });
    }

    // Draggable floating mascot
    if (this.dock && typeof this.dock.querySelector === 'function') {
      const viewport = this.dock.querySelector('.character-viewport') as HTMLElement | null;
      if (viewport && typeof viewport.addEventListener === 'function') {
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let initialLeft = 0;
        let initialTop = 0;
        let moved = false;

        viewport.addEventListener('pointerdown', ((e: PointerEvent) => {
          if (e.button !== 0) return;
          isDragging = true;
          moved = false;
          startX = e.clientX;
          startY = e.clientY;
          if (this.dock?.parentElement) {
            const rect = this.dock.getBoundingClientRect();
            const parentRect = this.dock.parentElement.getBoundingClientRect();
            initialLeft = rect.left - parentRect.left;
            initialTop = rect.top - parentRect.top;
          }
          try {
            viewport.setPointerCapture?.(e.pointerId);
          } catch {}
        }) as EventListener);

        window.addEventListener?.('pointermove', ((e: PointerEvent) => {
          if (!isDragging || !this.dock) return;
          const dx = e.clientX - startX;
          const dy = e.clientY - startY;
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
            moved = true;
          }
          if (this.dock.parentElement) {
            const parentRect = this.dock.parentElement.getBoundingClientRect();
            const dockW = this.dock.offsetWidth || 140;
            const dockH = this.dock.offsetHeight || 140;
            const newLeft = Math.max(0, Math.min(parentRect.width - dockW, initialLeft + dx));
            const newTop = Math.max(0, Math.min(parentRect.height - dockH, initialTop + dy));
            this.dock.style.left = `${newLeft}px`;
            this.dock.style.top = `${newTop}px`;
            this.dock.style.right = 'auto';
            this.dock.style.bottom = 'auto';
          }
        }) as EventListener);

        window.addEventListener?.('pointerup', ((e: PointerEvent) => {
          if (!isDragging) return;
          isDragging = false;
          try {
            viewport.releasePointerCapture?.(e.pointerId);
          } catch {}
          if (!moved) {
            this.char3d?.triggerHammerTap();
          }
        }) as EventListener);
      }
    }

    // Theme toggle buttons (Auto / White / Black)
    if (this.themeButtons) {
      this.themeButtons.forEach((btn: HTMLButtonElement) => {
        btn.addEventListener('click', () => {
          const t = btn.getAttribute('data-theme') as ForgeThemeMode;
          if (t) this.setThemeMode(t, true);
        });
        btn.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            const t = btn.getAttribute('data-theme') as ForgeThemeMode;
            if (t) this.setThemeMode(t, true);
          }
        });
      });
    }

    // Observe body class changes to update theme live if in Auto mode
    if (typeof MutationObserver !== 'undefined' && document.body) {
      this.bodyObserver = new MutationObserver(() => {
        this.applyThemeResolution(this.themeMode);
      });
      this.bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    // Input listeners: head looks toward prompt box while typing (DOES NOT set listening)
    const input = document.getElementById('input');
    if (input) {
      input.addEventListener('focus', () => {
        this.char3d?.setPromptTyping(true);
      });
      input.addEventListener('input', () => {
        this.char3d?.setPromptTyping(true);
      });
      input.addEventListener('blur', () => {
        this.char3d?.setPromptTyping(false);
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
    if (m.type === 'config' && m.panelTheme) {
      this.setThemeMode(m.panelTheme, false);
      return;
    }

    if (m.type === 'delta') {
      this.char3d?.setActivity(1.0);
    } else if (m.type === 'diffPreview') {
      this.char3d?.triggerHammerTap();
    }

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

  public setThemeMode(mode: ForgeThemeMode, persist = true): void {
    this.themeMode = mode;
    if (persist) {
      try {
        sessionStorage.setItem('forge.themeMode', mode);
        const vs = window.vscode;
        if (vs) {
          const st = vs.getState() || {};
          vs.setState({ ...st, themeMode: mode });
          vs.postMessage({ type: 'setTheme', theme: mode });
        }
      } catch {}
    }

    this.applyThemeResolution(mode);
  }

  private applyThemeResolution(mode: ForgeThemeMode): void {
    const bodyClass = document.body ? document.body.className : '';
    const res = resolveTheme(mode, bodyClass);
    this.resolvedTheme = res.theme;

    // Update Theme Switch UI
    if (this.themeButtons) {
      this.themeButtons.forEach((btn: HTMLButtonElement) => {
        const isMatch = btn.getAttribute('data-theme') === mode;
        btn.classList.toggle('active', isMatch);
        btn.setAttribute('aria-checked', isMatch ? 'true' : 'false');
        if (res.isHighContrast) {
          btn.disabled = true;
          btn.style.opacity = '0.5';
        } else {
          btn.disabled = false;
          btn.style.opacity = '1';
        }
      });
    }

    if (this.themeHcNotice) {
      this.themeHcNotice.style.display = res.isHighContrast ? 'inline-block' : 'none';
    }

    // Apply attribute on <html>
    if (typeof document !== 'undefined' && document.documentElement) {
      if (res.isHighContrast || mode === 'auto') {
        document.documentElement.removeAttribute('data-forge-theme');
      } else if (mode === 'light') {
        document.documentElement.setAttribute('data-forge-theme', 'light');
      } else if (mode === 'dark') {
        document.documentElement.setAttribute('data-forge-theme', 'dark');
      }
    }

    // Propagate resolved theme to 3D character
    this.char3d?.setTheme(res.theme);

    // Update 2D SVG avatar if currently rendered
    if (this.mode === '2D' && this.svgContainer) {
      this.svgContainer.innerHTML = renderCharacterSvg(this.state);
    }
  }

  public getThemeMode(): ForgeThemeMode {
    return this.themeMode;
  }

  public getResolvedTheme(): ResolvedTheme {
    return this.resolvedTheme;
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
            width: this.canvas.width || 140,
            height: this.canvas.height || 140,
            onFallback: (reason) => {
              console.warn(`[Forge Character] Fallback to 2D: ${reason}`);
              this.setMode('2D', true);
            },
          });
          this.char3d.setTheme(this.resolvedTheme);
        } catch {
          // Fallback to 2D if WebGL fails during constructor
          this.setMode('2D', true);
          return;
        }
      }

      this.char3d?.startAnimation();
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
    if (this.bodyObserver) {
      this.bodyObserver.disconnect();
      this.bodyObserver = null;
    }
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
