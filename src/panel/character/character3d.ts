import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  CylinderGeometry,
  SphereGeometry,
  CapsuleGeometry,
  CircleGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Points,
  PointsMaterial,
  MeshStandardMaterial,
  MeshBasicMaterial,
  AmbientLight,
  DirectionalLight,
  Group,
  Mesh,
  Color,
  LatheGeometry,
  Vector2,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { type CharacterState, STATE_CONFIGS } from './characterState';
import { computeStatePose, blendPoses, easeInOutQuad, type JointAngles, type PoseOptions } from './characterPose';
import { LIGHT_THEME, DARK_THEME, type ResolvedTheme } from './theme';

export interface Character3DOptions {
  canvas: HTMLCanvasElement;
  onFallback?: (reason: string) => void;
  width?: number;
  height?: number;
}

export class ForgeCharacter3D {
  private canvas: HTMLCanvasElement;
  private scene: Scene;
  private camera: PerspectiveCamera;
  private renderer: WebGLRenderer | null = null;

  // Root & Joint Hierarchy
  private root: Group;
  private hipsGroup: Group;
  private torsoGroup: Group;
  private neckGroup: Group;
  private headGroup: Group;
  private leftShoulderGroup: Group;
  private leftUpperArmGroup: Group;
  private leftLowerArmGroup: Group;
  private rightShoulderGroup: Group;
  private rightUpperArmGroup: Group;
  private rightLowerArmGroup: Group;
  private hammerGroup: Group;

  // Meshes & Materials
  private torsoMesh: Mesh;
  private headMesh: Mesh;
  private visorMesh: Mesh<RoundedBoxGeometry, MeshStandardMaterial>;
  private coreMesh: Mesh<CylinderGeometry, MeshStandardMaterial>;
  private leftEyeMesh: Mesh<CircleGeometry, MeshBasicMaterial>;
  private rightEyeMesh: Mesh<CircleGeometry, MeshBasicMaterial>;
  private shadowMesh: Mesh<CircleGeometry, MeshBasicMaterial>;
  private thoughtOrbsGroup: Group;
  private sparkPoints: Points;
  private earLeft: Mesh;
  private earRight: Mesh;

  // Lights
  private ambientLight: AmbientLight;
  private dirLight: DirectionalLight;
  private rimLight: DirectionalLight;

  // Theme & Materials
  private resolvedTheme: ResolvedTheme = 'dark';
  private bodyMaterial: MeshStandardMaterial;
  private headMaterial: MeshStandardMaterial;
  private jointMaterial: MeshStandardMaterial;
  private metalMaterial: MeshStandardMaterial;
  private visorMaterial: MeshStandardMaterial;
  private eyeMaterial: MeshBasicMaterial;

  // State & Animation
  private currentState: CharacterState = 'idle';
  private previousPose: JointAngles;
  private currentPose: JointAngles;
  private stateChangeTime = 0;
  private running = false;
  private rafId: number | null = null;
  private lastFrameTime = 0;
  private animTime = 0;
  private consecutiveSlowFrames = 0;
  private reducedMotion = false;
  private disposed = false;
  private onFallback?: (reason: string) => void;

  // Face Blinking
  private nextBlinkTime = 3.5;
  private isBlinking = false;
  private blinkStartTime = 0;

  // Speaking Activity & Typing
  private speakingActivity = 0;
  private targetActivity = 0;
  private isTyping = 0;
  private targetTyping = 0;

  constructor(options: Character3DOptions) {
    this.canvas = options.canvas;
    this.onFallback = options.onFallback;
    const width = options.width || 160;
    const height = options.height || 160;

    if (typeof window !== 'undefined' && window.matchMedia) {
      this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    // 1. Scene & Camera
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(36, width / height, 0.1, 100);
    this.camera.position.set(0, 1.25, 3.9);
    this.camera.lookAt(0, 0.95, 0);

    // 2. Initialize WebGL Renderer
    try {
      this.renderer = new WebGLRenderer({
        canvas: this.canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'low-power',
      });
      this.renderer.setSize(width, height, false);
      const pr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
      this.renderer.setPixelRatio(pr);
    } catch (err) {
      if (this.onFallback) {
        this.onFallback(`WebGL unsupported: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw err;
    }

    // 3. Setup context loss listener
    this.canvas.addEventListener('webglcontextlost', this.boundContextLost);

    // 4. Lights (Main, Ambient, and Rim Light)
    this.ambientLight = new AmbientLight(0xffffff, 0.85);
    this.scene.add(this.ambientLight);

    this.dirLight = new DirectionalLight(0xffffff, 1.3);
    this.dirLight.position.set(3, 5, 4);
    this.scene.add(this.dirLight);

    this.rimLight = new DirectionalLight(0x38bdf8, 0.8);
    this.rimLight.position.set(-3.5, 3, -3.5);
    this.scene.add(this.rimLight);

    // 5. Materials
    const initialPalette = this.resolvedTheme === 'light' ? LIGHT_THEME : DARK_THEME;
    this.bodyMaterial = new MeshStandardMaterial({
      color: new Color(initialPalette.characterBody),
      roughness: 0.42,
      metalness: 0.55,
    });
    this.headMaterial = new MeshStandardMaterial({
      color: new Color(initialPalette.characterHead),
      roughness: 0.38,
      metalness: 0.65,
    });
    this.jointMaterial = new MeshStandardMaterial({
      color: new Color(initialPalette.characterJoint),
      roughness: 0.5,
      metalness: 0.7,
    });
    this.metalMaterial = new MeshStandardMaterial({
      color: new Color(initialPalette.characterHammer),
      roughness: 0.3,
      metalness: 0.85,
    });
    this.visorMaterial = new MeshStandardMaterial({
      color: new Color(STATE_CONFIGS.idle.visorColor),
      emissive: new Color(STATE_CONFIGS.idle.visorColor),
      emissiveIntensity: 1.1,
      roughness: 0.1,
      metalness: 0.2,
    });
    this.eyeMaterial = new MeshBasicMaterial({
      color: 0xffffff,
    });

    // 6. Build Procedural Character Hierarchy
    this.root = new Group();
    this.scene.add(this.root);

    // Blob Shadow
    const shadowGeo = new CircleGeometry(0.7, 24);
    shadowGeo.rotateX(-Math.PI / 2);
    this.shadowMesh = new Mesh(
      shadowGeo,
      new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }),
    );
    this.shadowMesh.position.set(0, 0.02, 0);
    this.root.add(this.shadowMesh);

    // Hips
    this.hipsGroup = new Group();
    this.hipsGroup.position.set(0, 0.45, 0);
    this.root.add(this.hipsGroup);

    // Torso Group
    this.torsoGroup = new Group();
    this.torsoGroup.position.set(0, 0.4, 0);
    this.hipsGroup.add(this.torsoGroup);

    // Rounded Torso Mesh
    const torsoGeo = new RoundedBoxGeometry(0.78, 0.82, 0.52, 4, 0.12);
    this.torsoMesh = new Mesh(torsoGeo, this.bodyMaterial);
    this.torsoGroup.add(this.torsoMesh);

    // Glowing Chest Core
    const coreGeo = new CylinderGeometry(0.12, 0.12, 0.06, 16);
    coreGeo.rotateX(Math.PI / 2);
    this.coreMesh = new Mesh(coreGeo, this.visorMaterial);
    this.coreMesh.position.set(0, 0.08, 0.27);
    this.torsoGroup.add(this.coreMesh);

    // Neck
    this.neckGroup = new Group();
    this.neckGroup.position.set(0, 0.48, 0);
    const neckGeo = new SphereGeometry(0.1, 12, 12);
    const neckMesh = new Mesh(neckGeo, this.jointMaterial);
    this.neckGroup.add(neckMesh);
    this.torsoGroup.add(this.neckGroup);

    // Head Group
    this.headGroup = new Group();
    this.headGroup.position.set(0, 0.26, 0);
    this.neckGroup.add(this.headGroup);

    // Rounded Head Mesh
    const headGeo = new RoundedBoxGeometry(0.7, 0.55, 0.58, 4, 0.1);
    this.headMesh = new Mesh(headGeo, this.headMaterial);
    this.headGroup.add(this.headMesh);

    // Side Ear Exhausts (Capsules)
    const earGeo = new CapsuleGeometry(0.06, 0.14, 4, 8);
    this.earLeft = new Mesh(earGeo, this.jointMaterial);
    this.earLeft.position.set(-0.38, 0.04, 0);
    this.earLeft.rotation.z = Math.PI / 8;
    this.headGroup.add(this.earLeft);

    this.earRight = new Mesh(earGeo, this.jointMaterial);
    this.earRight.position.set(0.38, 0.04, 0);
    this.earRight.rotation.z = -Math.PI / 8;
    this.headGroup.add(this.earRight);

    // Visor
    const visorGeo = new RoundedBoxGeometry(0.56, 0.19, 0.07, 3, 0.04);
    this.visorMesh = new Mesh(visorGeo, this.visorMaterial);
    this.visorMesh.position.set(0, 0.02, 0.3);
    this.headGroup.add(this.visorMesh);

    // Visor Eyes (Blinking rounded planes)
    const eyeGeo = new CircleGeometry(0.04, 16);
    this.leftEyeMesh = new Mesh(eyeGeo, this.eyeMaterial);
    this.leftEyeMesh.position.set(-0.13, 0.02, 0.34);
    this.headGroup.add(this.leftEyeMesh);

    this.rightEyeMesh = new Mesh(eyeGeo, this.eyeMaterial);
    this.rightEyeMesh.position.set(0.13, 0.02, 0.34);
    this.headGroup.add(this.rightEyeMesh);

    // Thought Orbs Group (orbiting spheres during thinking)
    this.thoughtOrbsGroup = new Group();
    this.headGroup.add(this.thoughtOrbsGroup);
    const orbGeo = new SphereGeometry(0.045, 8, 8);
    for (let i = 0; i < 3; i++) {
      const angle = (i * 2 * Math.PI) / 3;
      const orb = new Mesh(orbGeo, this.visorMaterial);
      orb.position.set(Math.cos(angle) * 0.52, 0.32, Math.sin(angle) * 0.52);
      this.thoughtOrbsGroup.add(orb);
    }
    this.thoughtOrbsGroup.visible = false;

    // Left Arm Hierarchy
    this.leftShoulderGroup = new Group();
    this.leftShoulderGroup.position.set(-0.48, 0.32, 0);
    const shoulderGeo = new SphereGeometry(0.09, 12, 12);
    this.leftShoulderGroup.add(new Mesh(shoulderGeo, this.jointMaterial));
    this.torsoGroup.add(this.leftShoulderGroup);

    this.leftUpperArmGroup = new Group();
    const upperArmGeo = new CapsuleGeometry(0.065, 0.22, 4, 8);
    const leftUpperArmMesh = new Mesh(upperArmGeo, this.bodyMaterial);
    leftUpperArmMesh.position.set(0, -0.15, 0);
    this.leftUpperArmGroup.add(leftUpperArmMesh);
    this.leftShoulderGroup.add(this.leftUpperArmGroup);

    this.leftLowerArmGroup = new Group();
    this.leftLowerArmGroup.position.set(0, -0.28, 0);
    const elbowGeo = new SphereGeometry(0.075, 10, 10);
    this.leftLowerArmGroup.add(new Mesh(elbowGeo, this.jointMaterial));
    const lowerArmGeo = new CapsuleGeometry(0.06, 0.2, 4, 8);
    const leftLowerArmMesh = new Mesh(lowerArmGeo, this.bodyMaterial);
    leftLowerArmMesh.position.set(0, -0.14, 0);
    this.leftLowerArmGroup.add(leftLowerArmMesh);
    const handGeo = new SphereGeometry(0.07, 10, 10);
    const leftHand = new Mesh(handGeo, this.jointMaterial);
    leftHand.position.set(0, -0.26, 0);
    this.leftLowerArmGroup.add(leftHand);
    this.leftUpperArmGroup.add(this.leftLowerArmGroup);

    // Right Arm Hierarchy (controls hammer)
    this.rightShoulderGroup = new Group();
    this.rightShoulderGroup.position.set(0.48, 0.32, 0);
    this.rightShoulderGroup.add(new Mesh(shoulderGeo, this.jointMaterial));
    this.torsoGroup.add(this.rightShoulderGroup);

    this.rightUpperArmGroup = new Group();
    const rightUpperArmMesh = new Mesh(upperArmGeo, this.bodyMaterial);
    rightUpperArmMesh.position.set(0, -0.15, 0);
    this.rightUpperArmGroup.add(rightUpperArmMesh);
    this.rightShoulderGroup.add(this.rightUpperArmGroup);

    this.rightLowerArmGroup = new Group();
    this.rightLowerArmGroup.position.set(0, -0.28, 0);
    this.rightLowerArmGroup.add(new Mesh(elbowGeo, this.jointMaterial));
    const rightLowerArmMesh = new Mesh(lowerArmGeo, this.bodyMaterial);
    rightLowerArmMesh.position.set(0, -0.14, 0);
    this.rightLowerArmGroup.add(rightLowerArmMesh);

    // Right Hand & Hammer
    const rightHand = new Mesh(handGeo, this.jointMaterial);
    rightHand.position.set(0, -0.26, 0);
    this.rightLowerArmGroup.add(rightHand);

    this.hammerGroup = new Group();
    this.hammerGroup.position.set(0, -0.26, 0.05);

    // Hammer Handle
    const handleGeo = new CylinderGeometry(0.025, 0.025, 0.62, 10);
    const handleMesh = new Mesh(handleGeo, this.jointMaterial);
    handleMesh.position.set(0, 0.16, 0);
    this.hammerGroup.add(handleMesh);

    // Tapered Hammer Head
    const hammerHeadGeo = new RoundedBoxGeometry(0.24, 0.15, 0.15, 3, 0.03);
    const hammerHeadMesh = new Mesh(hammerHeadGeo, this.metalMaterial);
    hammerHeadMesh.position.set(0, 0.44, 0);
    this.hammerGroup.add(hammerHeadMesh);

    this.rightLowerArmGroup.add(this.hammerGroup);
    this.rightUpperArmGroup.add(this.rightLowerArmGroup);

    // Anvil (Lathe contour on side)
    const anvilGroup = new Group();
    anvilGroup.position.set(-0.55, 0.28, 0.25);
    const anvilPoints: Vector2[] = [
      new Vector2(0.24, 0),
      new Vector2(0.22, 0.08),
      new Vector2(0.12, 0.18),
      new Vector2(0.14, 0.25),
      new Vector2(0.28, 0.32),
      new Vector2(0.28, 0.38),
      new Vector2(0, 0.38),
    ];
    const anvilBodyGeo = new LatheGeometry(anvilPoints, 16);
    const anvilMesh = new Mesh(anvilBodyGeo, this.metalMaterial);
    anvilGroup.add(anvilMesh);

    // Anvil horn
    const hornGeo = new CylinderGeometry(0.02, 0.1, 0.22, 12);
    hornGeo.rotateZ(Math.PI / 2);
    const hornMesh = new Mesh(hornGeo, this.metalMaterial);
    hornMesh.position.set(-0.25, 0.35, 0);
    anvilGroup.add(hornMesh);
    this.root.add(anvilGroup);

    // Spark Particles for Success
    const sparkCount = 24;
    const sparkPositions = new Float32Array(sparkCount * 3);
    for (let i = 0; i < sparkCount; i++) {
      sparkPositions[i * 3] = (Math.random() - 0.5) * 0.8;
      sparkPositions[i * 3 + 1] = Math.random() * 0.8 + 0.6;
      sparkPositions[i * 3 + 2] = (Math.random() - 0.5) * 0.8;
    }
    const sparkGeo = new BufferGeometry();
    sparkGeo.setAttribute('position', new Float32BufferAttribute(sparkPositions, 3));
    this.sparkPoints = new Points(
      sparkGeo,
      new PointsMaterial({ color: 0x10b981, size: 0.04, transparent: true, opacity: 0.9 }),
    );
    this.sparkPoints.visible = false;
    this.root.add(this.sparkPoints);

    // Poses
    this.previousPose = computeStatePose('idle', 0);
    this.currentPose = computeStatePose('idle', 0);
    this.applyJointAngles(this.currentPose);
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

  /** Switches between light and dark palette dynamically with smooth 200ms transition */
  public setTheme(theme: ResolvedTheme): void {
    if (this.disposed) return;
    this.resolvedTheme = theme;
    const palette = theme === 'light' ? LIGHT_THEME : DARK_THEME;

    this.bodyMaterial.color.set(palette.characterBody);
    this.headMaterial.color.set(palette.characterHead);
    this.jointMaterial.color.set(palette.characterJoint);
    this.metalMaterial.color.set(palette.characterHammer);

    if (theme === 'light') {
      this.rimLight.color.set(0x0969da);
      this.rimLight.intensity = 0.6;
      this.shadowMesh.material.opacity = 0.16;
    } else {
      this.rimLight.color.set(0x388bfd);
      this.rimLight.intensity = 0.9;
      this.shadowMesh.material.opacity = 0.32;
    }

    if (this.reducedMotion) {
      this.render();
    }
  }

  /** Sets character state and triggers smooth 250ms pose blending */
  public setState(state: CharacterState): void {
    if (this.disposed) return;
    this.previousPose = { ...this.currentPose };
    this.currentState = state;
    this.stateChangeTime = this.animTime;

    const cfg = STATE_CONFIGS[state] || STATE_CONFIGS.idle;
    const targetColor = new Color(cfg.visorColor);
    this.visorMaterial.color.set(targetColor);
    this.visorMaterial.emissive.set(targetColor);

    if (state === 'thinking') {
      this.thoughtOrbsGroup.visible = true;
    } else {
      this.thoughtOrbsGroup.visible = false;
    }

    if (state === 'success') {
      this.sparkPoints.visible = true;
    } else {
      this.sparkPoints.visible = false;
    }

    if (this.reducedMotion) {
      this.currentPose = computeStatePose(state, 0);
      this.applyJointAngles(this.currentPose);
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

  /** Sets smoothed speaking activity level (0..1) driven by streaming deltas */
  public setActivity(level: number): void {
    this.targetActivity = Math.max(0, Math.min(1, level));
  }

  /** Sets typing flag when user focuses or types in Ask Forge prompt box */
  public setPromptTyping(typing: boolean): void {
    this.targetTyping = typing ? 1 : 0;
  }

  /** Triggers a single hammer tap on the anvil (e.g. on new diff preview) */
  public triggerHammerTap(): void {
    if (this.reducedMotion) return;
    this.rightUpperArmGroup.rotation.x = -0.45;
  }

  private applyJointAngles(p: JointAngles): void {
    this.root.position.y = p.rootY;

    this.hipsGroup.rotation.set(p.hips.x, p.hips.y, p.hips.z);
    this.torsoGroup.rotation.set(p.torso.x, p.torso.y, p.torso.z);
    this.neckGroup.rotation.set(p.neck.x, p.neck.y, p.neck.z);
    this.headGroup.rotation.set(p.head.x, p.head.y, p.head.z);

    this.leftShoulderGroup.rotation.set(p.leftShoulder.x, p.leftShoulder.y, p.leftShoulder.z);
    this.leftUpperArmGroup.rotation.set(p.leftUpperArm.x, p.leftUpperArm.y, p.leftUpperArm.z);
    this.leftLowerArmGroup.rotation.set(p.leftLowerArm.x, p.leftLowerArm.y, p.leftLowerArm.z);

    this.rightShoulderGroup.rotation.set(p.rightShoulder.x, p.rightShoulder.y, p.rightShoulder.z);
    this.rightUpperArmGroup.rotation.set(p.rightUpperArm.x, p.rightUpperArm.y, p.rightUpperArm.z);
    this.rightLowerArmGroup.rotation.set(p.rightLowerArm.x, p.rightLowerArm.y, p.rightLowerArm.z);
    this.hammerGroup.rotation.set(p.hammer.x, p.hammer.y, p.hammer.z);

    this.leftEyeMesh.scale.y = p.eyeScaleY;
    this.rightEyeMesh.scale.y = p.eyeScaleY;
    this.visorMaterial.emissiveIntensity = p.visorIntensity;

    if (this.thoughtOrbsGroup.visible) {
      this.thoughtOrbsGroup.rotation.y = p.thoughtOrbit;
    }
  }

  public startAnimation(): void {
    if (this.running || this.disposed || this.reducedMotion) return;
    this.running = true;
    this.lastFrameTime = performance.now();

    const loop = (timestamp: number) => {
      if (!this.running || this.disposed) return;

      const elapsed = timestamp - this.lastFrameTime;
      const targetInterval = 1000 / 30; // 30 fps cap

      if (elapsed >= targetInterval) {
        this.lastFrameTime = timestamp - (elapsed % targetInterval);
        this.animTime += 0.033;

        // Blinking cycle every 3 to 6 seconds
        if (!this.isBlinking && this.animTime >= this.nextBlinkTime) {
          this.isBlinking = true;
          this.blinkStartTime = this.animTime;
        }

        let blinkProgress = 0;
        if (this.isBlinking) {
          const blinkElapsed = this.animTime - this.blinkStartTime;
          if (blinkElapsed < 0.15) {
            blinkProgress = Math.sin((blinkElapsed / 0.15) * Math.PI);
          } else {
            this.isBlinking = false;
            this.nextBlinkTime = this.animTime + 3.0 + Math.random() * 3.0;
          }
        }

        // Smooth activity & typing transitions
        this.speakingActivity += (this.targetActivity - this.speakingActivity) * 0.15;
        this.isTyping += (this.targetTyping - this.isTyping) * 0.2;

        const options: PoseOptions = {
          activity: this.speakingActivity,
          isTyping: this.isTyping,
          blink: blinkProgress,
        };

        const targetPose = computeStatePose(this.currentState, this.animTime, options);

        // Blend between states in 250ms
        const blendDuration = 0.25;
        const timeSinceChange = this.animTime - this.stateChangeTime;
        if (timeSinceChange < blendDuration) {
          const factor = easeInOutQuad(timeSinceChange / blendDuration);
          this.currentPose = blendPoses(this.previousPose, targetPose, factor);
        } else {
          this.currentPose = targetPose;
        }

        const frameStart = performance.now();
        this.applyJointAngles(this.currentPose);
        this.render();
        const frameDuration = performance.now() - frameStart;

        // Watchdog: detect sustained slow frames (>50ms)
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

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAnimation();

    this.canvas.removeEventListener('webglcontextlost', this.boundContextLost);

    this.scene.traverse((obj) => {
      if ((obj as Mesh).isMesh || (obj as Points).isPoints) {
        const m = obj as Mesh;
        m.geometry?.dispose();
        if (Array.isArray(m.material)) {
          m.material.forEach((mat) => mat.dispose());
        } else {
          m.material?.dispose();
        }
      }
    });

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
  }
}
