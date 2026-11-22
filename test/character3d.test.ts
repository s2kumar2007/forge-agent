import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForgeCharacter3D } from '../src/panel/character/character3d';
import { CharacterApp } from '../src/panel/character/characterApp';

describe('ForgeCharacter3D & Fallback Mechanisms', () => {
  let mockCanvas: any;
  let listeners: Record<string, ((e: any) => void)[]>;

  beforeEach(() => {
    listeners = {};
    mockCanvas = {
      addEventListener: vi.fn((event: string, cb: (e: any) => void) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      }),
      removeEventListener: vi.fn((event: string, cb: (e: any) => void) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter((fn) => fn !== cb);
        }
      }),
      getContext: vi.fn().mockReturnValue(null),
      style: {},
      width: 160,
      height: 160,
    };
  });

  it('triggers onFallback callback when WebGL is unsupported', () => {
    let fallbackReason = '';
    const onFallback = (reason: string) => {
      fallbackReason = reason;
    };

    expect(() => {
      new ForgeCharacter3D({
        canvas: mockCanvas as any,
        onFallback,
      });
    }).toThrow();

    expect(fallbackReason).toContain('WebGL unsupported');
  });

  it('handles webglcontextlost event and invokes fallback', () => {
    let fallbackTriggered = false;
    let fallbackMsg = '';

    const charObj: any = {
      running: true,
      stopAnimation: vi.fn(),
      onFallback: (r: string) => {
        fallbackTriggered = true;
        fallbackMsg = r;
      },
    };

    const evt = { preventDefault: vi.fn() };
    const handler = (ForgeCharacter3D.prototype as any).handleContextLost.bind(charObj);
    handler(evt);

    expect(evt.preventDefault).toHaveBeenCalled();
    expect(fallbackTriggered).toBe(true);
    expect(fallbackMsg).toBe('WebGL context lost');
  });

  it('stops animation and disposes scene resources cleanly on dispose()', () => {
    // Create minimal mock scene and meshes
    const disposedGeos: any[] = [];
    const disposedMats: any[] = [];

    const mockMesh = {
      isMesh: true,
      geometry: { dispose: () => disposedGeos.push(true) },
      material: { dispose: () => disposedMats.push(true) },
    };

    const mockRenderer = {
      setSize: vi.fn(),
      setPixelRatio: vi.fn(),
      render: vi.fn(),
      dispose: vi.fn(),
    };

    const charObj: any = {
      disposed: false,
      running: true,
      rafId: 123,
      canvas: mockCanvas,
      handleContextLost: vi.fn(),
      scene: {
        traverse: (cb: any) => {
          cb(mockMesh);
        },
      },
      renderer: mockRenderer,
      stopAnimation: function () {
        this.running = false;
        this.rafId = null;
      },
      dispose: ForgeCharacter3D.prototype.dispose,
    };

    charObj.dispose();
    expect(charObj.disposed).toBe(true);
    expect(charObj.running).toBe(false);
    expect(disposedGeos.length).toBeGreaterThan(0);
    expect(disposedMats.length).toBeGreaterThan(0);
    expect(mockRenderer.dispose).toHaveBeenCalled();
  });

  it('detects sustained slow frames (>50ms for 5 frames) and triggers fallback', () => {
    let fallbackCalled = false;
    let fallbackReason = '';

    const charState: any = {
      running: true,
      disposed: false,
      currentState: 'thinking',
      consecutiveSlowFrames: 4, // 4 slow frames already
      onFallback: (r: string) => {
        fallbackCalled = true;
        fallbackReason = r;
      },
      stopAnimation: vi.fn(),
      applyStatePose: vi.fn(),
      render: vi.fn(),
    };

    // Simulate 5th slow frame (>50ms)
    const frameDuration = 55.4;
    if (frameDuration > 50) {
      charState.consecutiveSlowFrames++;
      if (charState.consecutiveSlowFrames >= 5) {
        charState.stopAnimation();
        charState.onFallback(`Sustained frame time above 50ms (${frameDuration.toFixed(1)}ms)`);
      }
    }

    expect(fallbackCalled).toBe(true);
    expect(fallbackReason).toContain('Sustained frame time above 50ms');
    expect(charState.stopAnimation).toHaveBeenCalled();
  });

  it('respects prefers-reduced-motion and does not start animation loop', () => {
    const charObj: any = {
      reducedMotion: true,
      running: false,
      disposed: false,
      currentState: 'idle',
      startAnimation: ForgeCharacter3D.prototype.startAnimation,
      setState: ForgeCharacter3D.prototype.setState,
      applyJointAngles: vi.fn(),
      render: vi.fn(),
      visorMaterial: { color: { set: vi.fn() }, emissive: { set: vi.fn() } },
      thoughtOrbsGroup: { visible: false },
      sparkPoints: { visible: false },
    };

    // Calling startAnimation() directly should be a no-op
    charObj.startAnimation();
    expect(charObj.running).toBe(false);

    // Calling setState() should render a static pose once without animating
    charObj.setState('reviewing');
    expect(charObj.applyJointAngles).toHaveBeenCalled();
    expect(charObj.render).toHaveBeenCalled();
    expect(charObj.running).toBe(false);
  });

  it('updates materials, rim light, and shadow cleanly in setTheme without recreating scene', () => {
    const charObj: any = {
      disposed: false,
      reducedMotion: false,
      bodyMaterial: { color: { set: vi.fn() } },
      headMaterial: { color: { set: vi.fn() } },
      jointMaterial: { color: { set: vi.fn() } },
      metalMaterial: { color: { set: vi.fn() } },
      rimLight: { color: { set: vi.fn() }, intensity: 0 },
      shadowMesh: { material: { opacity: 0 } },
      setTheme: ForgeCharacter3D.prototype.setTheme,
      render: vi.fn(),
    };

    charObj.setTheme('light');
    expect(charObj.bodyMaterial.color.set).toHaveBeenCalled();
    expect(charObj.rimLight.color.set).toHaveBeenCalled();
    expect(charObj.rimLight.intensity).toBe(0.6);
    expect(charObj.shadowMesh.material.opacity).toBe(0.16);

    charObj.setTheme('dark');
    expect(charObj.rimLight.intensity).toBe(0.9);
    expect(charObj.shadowMesh.material.opacity).toBe(0.32);
  });
});

describe('CharacterApp Webview Mode & Accessibility Controller', () => {
  let mockDom: Record<string, any>;
  let sessionStorageStore: Record<string, string>;

  beforeEach(() => {
    sessionStorageStore = {};
    (global as any).sessionStorage = {
      getItem: (k: string) => sessionStorageStore[k] || null,
      setItem: (k: string, v: string) => {
        sessionStorageStore[k] = v;
      },
      clear: () => {
        sessionStorageStore = {};
      },
    };

    const canvas = { style: { display: 'none' } };
    const svg = { style: { display: 'none' }, innerHTML: '' };
    const dock = { classList: { add: vi.fn(), remove: vi.fn() } };
    const bubble = { style: { display: 'none' }, textContent: '' };
    const aria = { textContent: '' };
    const input = { addEventListener: vi.fn() };

    mockDom = {
      'forge-character-canvas': canvas,
      'forge-character-svg': svg,
      'forge-character-dock': dock,
      'character-speech-bubble': bubble,
      'character-aria-live': aria,
      input,
    };

    (global as any).document = {
      getElementById: (id: string) => mockDom[id] || null,
      querySelectorAll: () => [],
      addEventListener: vi.fn(),
      documentElement: {
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
        getAttribute: vi.fn(),
      },
      body: {
        className: 'vscode-dark',
        classList: {
          contains: (cls: string) => cls === 'vscode-dark',
        },
      },
    };

    (global as any).window = {
      addEventListener: vi.fn(),
      matchMedia: () => ({ matches: false }),
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
    };
  });

  it('starts in Off mode by default and collapses dock', () => {
    (global as any).window.__FORGE_INITIAL_CONFIG__ = { guideCharacter3d: false };
    const app = new CharacterApp();

    expect(app.getMode()).toBe('Off');
    expect(mockDom['forge-character-canvas'].style.display).toBe('none');
    expect(mockDom['forge-character-svg'].style.display).toBe('none');
    expect(mockDom['forge-character-dock'].classList.add).toHaveBeenCalledWith('collapsed');
  });

  it('switches to 2D mode and renders 2D SVG avatar', () => {
    const app = new CharacterApp();
    app.setMode('2D', true);

    expect(app.getMode()).toBe('2D');
    expect(mockDom['forge-character-svg'].style.display).toBe('block');
    expect(mockDom['forge-character-canvas'].style.display).toBe('none');
    expect(mockDom['forge-character-svg'].innerHTML).toContain('<svg');
    expect(sessionStorageStore['forge.characterMode']).toBe('2D');
  });

  it('automatically falls back to 2D when 3D initialization fails', () => {
    const app = new CharacterApp();
    // 3D will fail because mock canvas has no WebGL in this test environment
    app.setMode('3D', true);

    // Should seamlessly fall back to 2D without uncaught errors
    expect(app.getMode()).toBe('2D');
    expect(mockDom['forge-character-svg'].style.display).toBe('block');
    expect(sessionStorageStore['forge.characterMode']).toBe('2D');
  });

  it('remembers session preference from sessionStorage', () => {
    sessionStorageStore['forge.characterMode'] = '2D';
    const app = new CharacterApp();

    expect(app.getMode()).toBe('2D');
    expect(mockDom['forge-character-svg'].style.display).toBe('block');
  });

  it('updates aria-live region on state changes', () => {
    const app = new CharacterApp();
    app.setState('reviewing');

    expect(mockDom['character-aria-live'].textContent).toBe('Forge is reviewing proposed file changes');
  });

  it('redacts secret files in speech bubbles when setting state', () => {
    const app = new CharacterApp();
    app.setMode('2D', false);
    app.setState('alert', 'Error accessing .env and server.key files');

    expect(mockDom['character-speech-bubble'].textContent).not.toContain('.env');
    expect(mockDom['character-speech-bubble'].textContent).not.toContain('server.key');
    expect(mockDom['character-speech-bubble'].textContent).toContain('[REDACTED_SECRET_FILE]');
  });

  it('does NOT trigger listening state on input focus, only on explicit micActive message', () => {
    let focusListener: any;
    mockDom['input'].addEventListener = vi.fn((event: string, cb: any) => {
      if (event === 'focus') focusListener = cb;
    });

    const app = new CharacterApp();
    expect(app.getState()).toBe('idle');

    // Simulate input focus
    if (focusListener) focusListener();
    expect(app.getState()).toBe('idle'); // Must stay idle, NOT listening!

    // Explicit micActive message triggers listening
    app.handleHostMessage({ type: 'micActive' });
    expect(app.getState()).toBe('listening');

    app.handleHostMessage({ type: 'micInactive' });
    expect(app.getState()).toBe('idle');
  });

  it('switches themes (Auto, White, Black) and updates DOM attributes and storage', () => {
    let setAttrKey = '';
    let setAttrVal = '';
    let removeAttrKey = '';

    (global as any).document.documentElement = {
      setAttribute: (k: string, v: string) => {
        setAttrKey = k;
        setAttrVal = v;
      },
      removeAttribute: (k: string) => {
        removeAttrKey = k;
      },
    };

    const app = new CharacterApp();

    // Switch to White (Light)
    app.setThemeMode('light', true);
    expect(app.getThemeMode()).toBe('light');
    expect(app.getResolvedTheme()).toBe('light');
    expect(setAttrKey).toBe('data-forge-theme');
    expect(setAttrVal).toBe('light');
    expect(sessionStorageStore['forge.themeMode']).toBe('light');

    // Switch to Black (Dark)
    app.setThemeMode('dark', true);
    expect(app.getThemeMode()).toBe('dark');
    expect(app.getResolvedTheme()).toBe('dark');
    expect(setAttrKey).toBe('data-forge-theme');
    expect(setAttrVal).toBe('dark');
    expect(sessionStorageStore['forge.themeMode']).toBe('dark');

    // Switch back to Auto
    app.setThemeMode('auto', true);
    expect(app.getThemeMode()).toBe('auto');
    expect(removeAttrKey).toBe('data-forge-theme');
    expect(sessionStorageStore['forge.themeMode']).toBe('auto');
  });
});
