import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  BoxGeometry,
  CylinderGeometry,
  SphereGeometry,
  MeshStandardMaterial,
  MeshBasicMaterial,
  AmbientLight,
  DirectionalLight,
  Group,
  Mesh,
  Color,
  MathUtils,
} from 'three';
import { type CharacterState, STATE_CONFIGS } from './characterState';

export interface Character3DOptions {
  canvas: HTMLCanvasElement;
  onFallback?: (reason: string) => void;
  width?: number;
  height?: number;
}

/**
 * Procedural 3D Forge Character rendered via Three.js.
 * Built entirely from low-poly primitives (torso, head, glowing visor, hammer, anvil).
 * Tree-shaken, 30fps capped, pauses when hidden, detects context loss and slow frames.
 */
export class ForgeCharacter3D {
  private canvas: HTMLCanvasElement;
  private scene: Scene;
  private camera: PerspectiveCamera;
  private renderer: WebGLRenderer | null = null;
  private root: Group;
  private torso: Mesh<BoxGeometry, MeshStandardMaterial>;
  private headGroup: Group;
  private visorMesh: Mesh<BoxGeometry, MeshStandardMaterial>;
  private coreMesh: Mesh<CylinderGeometry, MeshStandardMaterial>;
  private rightArmGroup: Group;
  private hammerGroup: Group;
  private anvilGroup: Group;
  private dirLight: DirectionalLight;
  private ambientLight: AmbientLight;

  private currentState: CharacterState = 'idle';
  private running = false;
  private rafId: number | null = null;
  private lastFrameTime = 0;
  private animTime = 0;
  private consecutiveSlowFrames = 0;
  private reducedMotion = false;
  private disposed = false;
  private onFallback?: (reason: string) => void;

  constructor(options: Character3DOptions) {
    this.canvas = options.canvas;
    this.onFallback = options.onFallback;
    const width = options.width || 160;
    const height = options.height || 160;

    // Check prefers-reduced-motion
    if (typeof window !== 'undefined' && window.matchMedia) {
      this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    // 1. Scene & Camera
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(38, width / height, 0.1, 100);
    this.camera.position.set(0, 1.2, 4.0);
    this.camera.lookAt(0, 0.9, 0);

    // 2. Initialize WebGL Renderer
    try {
      this.renderer = new WebGLRenderer({
        canvas: this.canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'low-power',
      });
      this.renderer.setSize(width, height, false);
      this.renderer.setPixelRatio(Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2));
    } catch (err) {
      if (this.onFallback) {
        this.onFallback(`WebGL unsupported: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw err;
    }

    // 3. Setup context loss listener
    this.canvas.addEventListener('webglcontextlost', this.boundContextLost);

    // 4. Lights
    this.ambientLight = new AmbientLight(0xffffff, 0.85);
    this.scene.add(this.ambientLight);

    this.dirLight = new DirectionalLight(0xffffff, 1.2);
    this.dirLight.position.set(3, 5, 4);
    this.scene.add(this.dirLight);

    // 5. Build Procedural Character
    this.root = new Group();
    this.scene.add(this.root);

    // Read colors from theme
    const colors = this.extractThemeColors();

    // Torso (low-poly chamfered robot body)
    const torsoGeo = new BoxGeometry(0.8, 0.85, 0.55);
    const torsoMat = new MeshStandardMaterial({
      color: colors.torso,
      roughness: 0.45,
      metalness: 0.6,
    });
    this.torso = new Mesh(torsoGeo, torsoMat);
    this.torso.position.set(0, 0.85, 0);
    this.root.add(this.torso);

    // Chest Core (glowing power reactor on chest)
    const coreGeo = new CylinderGeometry(0.12, 0.12, 0.08, 12);
    coreGeo.rotateX(Math.PI / 2);
    const coreMat = new MeshStandardMaterial({
      color: 0x111116,
      emissive: new Color(STATE_CONFIGS.idle.visorColor),
      emissiveIntensity: 0.8,
      roughness: 0.2,
      metalness: 0.8,
    });
    this.coreMesh = new Mesh(coreGeo, coreMat);
    this.coreMesh.position.set(0, 0.95, 0.28);
    this.root.add(this.coreMesh);

    // Head Group
    this.headGroup = new Group();
    this.headGroup.position.set(0, 1.45, 0);

    // Head Box
    const headGeo = new BoxGeometry(0.72, 0.56, 0.6);
    const headMat = new MeshStandardMaterial({
      color: colors.head,
      roughness: 0.35,
      metalness: 0.7,
    });
    const headMesh = new Mesh(headGeo, headMat);
    this.headGroup.add(headMesh);

    // Side Ear Exhausts / Antennas
    const earGeo = new CylinderGeometry(0.06, 0.08, 0.18, 6);
    const earMat = new MeshStandardMaterial({ color: 0x3a3d4f, roughness: 0.5, metalness: 0.7 });
    const leftEar = new Mesh(earGeo, earMat);
    leftEar.position.set(-0.38, 0.05, 0);
    leftEar.rotation.z = Math.PI / 8;
    this.headGroup.add(leftEar);

    const rightEar = new Mesh(earGeo, earMat);
    rightEar.position.set(0.38, 0.05, 0);
    rightEar.rotation.z = -Math.PI / 8;
    this.headGroup.add(rightEar);

    // Glowing Visor
    const visorGeo = new BoxGeometry(0.56, 0.18, 0.08);
    const visorMat = new MeshStandardMaterial({
      color: new Color(STATE_CONFIGS.idle.visorColor),
      emissive: new Color(STATE_CONFIGS.idle.visorColor),
      emissiveIntensity: 1.0,
      roughness: 0.1,
      metalness: 0.2,
    });
    this.visorMesh = new Mesh(visorGeo, visorMat);
    this.visorMesh.position.set(0, 0.04, 0.31);
    this.headGroup.add(this.visorMesh);

    this.root.add(this.headGroup);

    // Left Arm (relaxed on waist/anvil)
    const leftArmGroup = new Group();
    leftArmGroup.position.set(-0.46, 1.15, 0);
    const armGeo = new CylinderGeometry(0.08, 0.08, 0.5, 8);
    const armMat = new MeshStandardMaterial({ color: 0x2b2e3c, roughness: 0.5, metalness: 0.7 });
    const leftArmMesh = new Mesh(armGeo, armMat);
    leftArmMesh.position.set(-0.12, -0.22, 0.05);
    leftArmMesh.rotation.z = Math.PI / 6;
    leftArmGroup.add(leftArmMesh);
    this.root.add(leftArmGroup);

    // Right Arm (articulates hammer)
    this.rightArmGroup = new Group();
    this.rightArmGroup.position.set(0.46, 1.15, 0);
    const rightArmMesh = new Mesh(armGeo, armMat);
    rightArmMesh.position.set(0.12, -0.22, 0.05);
    rightArmMesh.rotation.z = -Math.PI / 6;
    this.rightArmGroup.add(rightArmMesh);

    // Hammer in right hand
    this.hammerGroup = new Group();
    this.hammerGroup.position.set(0.24, -0.42, 0.15);

    // Hammer Handle
    const handleGeo = new CylinderGeometry(0.03, 0.03, 0.65, 8);
    const handleMat = new MeshStandardMaterial({ color: 0x92400e, roughness: 0.8, metalness: 0.1 });
    const handleMesh = new Mesh(handleGeo, handleMat);
    handleMesh.position.set(0, 0.15, 0);
    this.hammerGroup.add(handleMesh);

    // Hammer Head
    const hammerHeadGeo = new BoxGeometry(0.26, 0.16, 0.16);
    const hammerHeadMat = new MeshStandardMaterial({ color: 0x475569, roughness: 0.3, metalness: 0.8 });
    const hammerHeadMesh = new Mesh(hammerHeadGeo, hammerHeadMat);
    hammerHeadMesh.position.set(0, 0.42, 0);
    this.hammerGroup.add(hammerHeadMesh);

    this.rightArmGroup.add(this.hammerGroup);
    this.root.add(this.rightArmGroup);

    // Anvil (beside the character)
    this.anvilGroup = new Group();
    this.anvilGroup.position.set(-0.55, 0.35, 0.3);

    // Anvil base
    const anvilBaseGeo = new BoxGeometry(0.48, 0.16, 0.36);
    const anvilMat = new MeshStandardMaterial({ color: 0x334155, roughness: 0.4, metalness: 0.8 });
    const anvilBase = new Mesh(anvilBaseGeo, anvilMat);
    this.anvilGroup.add(anvilBase);

    // Anvil waist
    const anvilWaistGeo = new BoxGeometry(0.26, 0.2, 0.22);
    const anvilWaist = new Mesh(anvilWaistGeo, anvilMat);
    anvilWaist.position.set(0, 0.15, 0);
    this.anvilGroup.add(anvilWaist);

    // Anvil table & horn
    const anvilTopGeo = new BoxGeometry(0.62, 0.16, 0.3);
    const anvilTop = new Mesh(anvilTopGeo, anvilMat);
    anvilTop.position.set(0, 0.31, 0);
    this.anvilGroup.add(anvilTop);

    // Anvil horn cone
    const hornGeo = new CylinderGeometry(0.02, 0.12, 0.24, 6);
    hornGeo.rotateZ(Math.PI / 2);
    const horn = new Mesh(hornGeo, anvilMat);
    horn.position.set(-0.4, 0.31, 0);
    this.anvilGroup.add(horn);

    this.root.add(this.anvilGroup);

    // Render initial static frame
    this.applyStatePose(this.currentState, 0);
    this.render();
  }

  private boundContextLost = (e: Event): void => this.handleContextLost(e);

  public handleContextLost(e: Event): void {
    e.preventDefault();
    this.stopAnimation();
    if (this.onFallback) {
      this.onFallback('WebGL context lost');
    }
  }

  private extractThemeColors(): { torso: number; head: number } {
    let torso = 0x242838;
    let head = 0x1e202e;
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      try {
        const style = getComputedStyle(document.body);
        const bg = style.getPropertyValue('--vscode-sideBar-background').trim();
        const btn = style.getPropertyValue('--vscode-button-background').trim();
        if (btn) torso = new Color(btn).getHex();
        if (bg) head = new Color(bg).getHex();
      } catch {}
    }
    return { torso, head };
  }

  /** Sets character state, transitions visor color, and starts or adjusts animation */
  public setState(state: CharacterState): void {
    if (this.disposed) return;
    this.currentState = state;
    const cfg = STATE_CONFIGS[state] || STATE_CONFIGS.idle;
    const targetColor = new Color(cfg.visorColor);

    this.visorMesh.material.color.set(targetColor);
    this.visorMesh.material.emissive.set(targetColor);
    this.coreMesh.material.emissive.set(targetColor);

    if (this.reducedMotion) {
      this.applyStatePose(state, 0);
      this.render();
      return;
    }

    if (!this.running) {
      this.startAnimation();
    }
  }

  public getState(): CharacterState {
    return this.currentState;
  }

  /** Applies pose offsets and joint rotations for a specific state */
  public applyStatePose(state: CharacterState, time: number): void {
    const t = time;

    switch (state) {
      case 'idle':
        // Gentle breathing and floating
        this.root.position.y = Math.sin(t * 2) * 0.03;
        this.headGroup.rotation.x = Math.sin(t * 1.5) * 0.02;
        this.headGroup.rotation.y = Math.sin(t * 0.8) * 0.03;
        this.headGroup.rotation.z = 0;
        this.rightArmGroup.rotation.z = Math.sin(t * 2) * 0.04;
        this.rightArmGroup.rotation.x = 0;
        this.hammerGroup.rotation.set(0, 0, 0);
        this.visorMesh.material.emissiveIntensity = 0.9 + Math.sin(t * 3) * 0.2;
        break;

      case 'listening':
        // Attentive posture, head tilted up toward user
        this.root.position.y = 0.04;
        this.headGroup.rotation.x = -0.18;
        this.headGroup.rotation.y = Math.sin(t * 3) * 0.05;
        this.headGroup.rotation.z = 0.05;
        this.rightArmGroup.rotation.z = -0.2;
        this.rightArmGroup.rotation.x = -0.1;
        this.visorMesh.material.emissiveIntensity = 1.2 + Math.sin(t * 5) * 0.3;
        break;

      case 'thinking':
        // Pondering pose, head tilted, rhythmic hammer tapping on anvil
        this.root.position.y = 0;
        this.headGroup.rotation.x = 0.1;
        this.headGroup.rotation.y = -0.15;
        this.headGroup.rotation.z = 0.12;
        // Hammer tap cycle
        const tap = Math.sin(t * 6);
        this.rightArmGroup.rotation.x = tap > 0.3 ? -0.4 : 0.1;
        this.rightArmGroup.rotation.z = -0.3;
        this.visorMesh.material.emissiveIntensity = 1.0 + Math.sin(t * 8) * 0.4;
        break;

      case 'speaking':
        // Gentle head bobbing in cadence with output speech
        this.root.position.y = Math.sin(t * 4) * 0.02;
        this.headGroup.rotation.x = Math.sin(t * 6) * 0.06;
        this.headGroup.rotation.y = Math.sin(t * 2) * 0.04;
        this.headGroup.rotation.z = 0;
        this.rightArmGroup.rotation.z = Math.sin(t * 4) * 0.05;
        this.visorMesh.material.emissiveIntensity = 1.1 + Math.sin(t * 10) * 0.4;
        break;

      case 'reviewing':
        // Leaning forward intently inspecting diffs
        this.root.position.y = -0.02;
        this.headGroup.rotation.x = 0.28;
        this.headGroup.rotation.y = Math.sin(t * 2) * 0.08;
        this.headGroup.rotation.z = 0;
        this.rightArmGroup.rotation.x = -0.25;
        this.rightArmGroup.rotation.z = -0.15;
        this.visorMesh.material.emissiveIntensity = 1.3;
        break;

      case 'alert':
        // Startled / alerted upright pose with slight rapid shake
        this.root.position.y = 0.05;
        this.headGroup.rotation.x = -0.12;
        this.headGroup.rotation.y = Math.sin(t * 18) * 0.06; // rapid shake
        this.headGroup.rotation.z = 0;
        this.rightArmGroup.rotation.z = -0.5; // defensive hammer
        this.rightArmGroup.rotation.x = -0.3;
        this.visorMesh.material.emissiveIntensity = 1.4 + Math.sin(t * 15) * 0.4;
        break;

      case 'success':
        // Triumphant cheer with hammer raised high
        const bounce = Math.abs(Math.sin(t * 5)) * 0.08;
        this.root.position.y = bounce;
        this.headGroup.rotation.x = -0.15;
        this.headGroup.rotation.y = Math.sin(t * 3) * 0.05;
        this.headGroup.rotation.z = 0;
        this.rightArmGroup.rotation.z = -1.2; // arm held up
        this.rightArmGroup.rotation.x = -0.2;
        this.hammerGroup.rotation.z = -0.4;
        this.visorMesh.material.emissiveIntensity = 1.3 + Math.sin(t * 6) * 0.3;
        break;
    }
  }

  /** 30 fps capped animation loop with performance tracking */
  public startAnimation(): void {
    if (this.running || this.disposed || this.reducedMotion) return;
    this.running = true;
    this.lastFrameTime = performance.now();

    const loop = (timestamp: number) => {
      if (!this.running || this.disposed) return;

      const elapsed = timestamp - this.lastFrameTime;
      const targetInterval = 1000 / 30; // 33.33ms (30 fps cap)

      if (elapsed >= targetInterval) {
        this.lastFrameTime = timestamp - (elapsed % targetInterval);
        this.animTime += 0.033;

        // Measure frame render duration to detect slow devices
        const frameStart = performance.now();
        this.applyStatePose(this.currentState, this.animTime);
        this.render();
        const frameDuration = performance.now() - frameStart;

        if (frameDuration > 50) {
          this.consecutiveSlowFrames++;
          if (this.consecutiveSlowFrames >= 5) {
            this.stopAnimation();
            if (this.onFallback) {
              this.onFallback(`Sustained frame time above 50ms (${frameDuration.toFixed(1)}ms)`);
            }
            return;
          }
        } else {
          this.consecutiveSlowFrames = 0;
        }
      }

      this.rafId = requestAnimationFrame(loop);
    };

    this.rafId = requestAnimationFrame(loop);
  }

  public stopAnimation(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  public render(): void {
    if (this.renderer && !this.disposed) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** Complete disposal of WebGL resources to prevent memory leaks */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAnimation();

    this.canvas.removeEventListener('webglcontextlost', this.boundContextLost);

    this.scene.traverse((obj) => {
      if ((obj as Mesh).isMesh) {
        const mesh = obj as Mesh;
        mesh.geometry?.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m) => m.dispose());
        } else {
          mesh.material?.dispose();
        }
      }
    });

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
  }
}
