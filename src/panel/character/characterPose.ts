import type { CharacterState } from './characterState';

export interface JointTransform {
  x: number;
  y: number;
  z: number;
}

export interface JointAngles {
  rootY: number;
  hips: JointTransform;
  torso: JointTransform;
  neck: JointTransform;
  head: JointTransform;
  leftShoulder: JointTransform;
  leftUpperArm: JointTransform;
  leftLowerArm: JointTransform;
  rightShoulder: JointTransform;
  rightUpperArm: JointTransform;
  rightLowerArm: JointTransform;
  hammer: JointTransform;
  eyeScaleY: number;
  visorIntensity: number;
  thoughtOrbit: number;
  sparkActive: boolean;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function interpolateTransform(a: JointTransform, b: JointTransform, t: number): JointTransform {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
  };
}

export function blendPoses(from: JointAngles, to: JointAngles, factor: number): JointAngles {
  const f = Math.max(0, Math.min(1, factor));
  return {
    rootY: lerp(from.rootY, to.rootY, f),
    hips: interpolateTransform(from.hips, to.hips, f),
    torso: interpolateTransform(from.torso, to.torso, f),
    neck: interpolateTransform(from.neck, to.neck, f),
    head: interpolateTransform(from.head, to.head, f),
    leftShoulder: interpolateTransform(from.leftShoulder, to.leftShoulder, f),
    leftUpperArm: interpolateTransform(from.leftUpperArm, to.leftUpperArm, f),
    leftLowerArm: interpolateTransform(from.leftLowerArm, to.leftLowerArm, f),
    rightShoulder: interpolateTransform(from.rightShoulder, to.rightShoulder, f),
    rightUpperArm: interpolateTransform(from.rightUpperArm, to.rightUpperArm, f),
    rightLowerArm: interpolateTransform(from.rightLowerArm, to.rightLowerArm, f),
    hammer: interpolateTransform(from.hammer, to.hammer, f),
    eyeScaleY: lerp(from.eyeScaleY, to.eyeScaleY, f),
    visorIntensity: lerp(from.visorIntensity, to.visorIntensity, f),
    thoughtOrbit: to.thoughtOrbit,
    sparkActive: to.sparkActive,
  };
}

export interface PoseOptions {
  activity?: number; // 0..1 smoothed speaking activity
  isTyping?: number; // 0..1 typing looking down factor
  blink?: number; // 0..1 blink progress (0: open, 1: closed)
}

/** Pure function calculating joint angles for any character state and time */
export function computeStatePose(
  state: CharacterState,
  time: number,
  options: PoseOptions = {},
): JointAngles {
  const t = time;
  const act = options.activity ?? 0;
  const typing = options.isTyping ?? 0;
  const blinkVal = options.blink ?? 0;
  const eyeScaleY = 1.0 - 0.95 * blinkVal; // 1 -> 0.05 when blinking

  const zeroTransform: JointTransform = { x: 0, y: 0, z: 0 };

  switch (state) {
    case 'idle':
      return {
        rootY: Math.sin(t * 2) * 0.03,
        hips: zeroTransform,
        torso: { x: Math.sin(t * 1.8) * 0.015, y: 0, z: 0 },
        neck: zeroTransform,
        head: {
          x: Math.sin(t * 1.5) * 0.02 + typing * 0.15,
          y: Math.sin(t * 0.9) * 0.03,
          z: Math.sin(t * 1.1) * 0.015,
        },
        leftShoulder: zeroTransform,
        leftUpperArm: { x: 0, y: 0, z: 0.25 },
        leftLowerArm: { x: -0.2, y: 0, z: 0 },
        rightShoulder: zeroTransform,
        rightUpperArm: { x: 0, y: 0, z: -0.25 + Math.sin(t * 2) * 0.03 },
        rightLowerArm: { x: -0.15, y: 0, z: 0 },
        hammer: zeroTransform,
        eyeScaleY,
        visorIntensity: 0.9 + Math.sin(t * 2.5) * 0.15,
        thoughtOrbit: 0,
        sparkActive: false,
      };

    case 'listening':
      return {
        rootY: 0.03,
        hips: zeroTransform,
        torso: { x: 0.08, y: 0, z: 0 },
        neck: zeroTransform,
        head: { x: -0.18 + typing * 0.1, y: Math.sin(t * 2) * 0.04, z: 0.06 },
        leftShoulder: zeroTransform,
        leftUpperArm: { x: 0, y: 0, z: 0.2 },
        leftLowerArm: { x: -0.3, y: 0, z: 0 },
        rightShoulder: zeroTransform,
        rightUpperArm: { x: -0.1, y: 0, z: -0.35 },
        rightLowerArm: { x: -0.25, y: 0, z: 0 },
        hammer: zeroTransform,
        eyeScaleY,
        visorIntensity: 1.25 + Math.sin(t * 4) * 0.25,
        thoughtOrbit: 0,
        sparkActive: false,
      };

    case 'thinking':
      const tapCycle = Math.sin(t * 5.5);
      return {
        rootY: 0.01,
        hips: zeroTransform,
        torso: { x: -0.04, y: 0, z: 0 },
        neck: zeroTransform,
        head: { x: -0.14 + typing * 0.12, y: -0.18, z: 0.15 },
        leftShoulder: zeroTransform,
        leftUpperArm: { x: 0, y: 0, z: 0.3 },
        leftLowerArm: { x: -0.35, y: 0, z: 0 },
        rightShoulder: zeroTransform,
        rightUpperArm: { x: tapCycle > 0.35 ? -0.38 : 0.05, y: 0, z: -0.3 },
        rightLowerArm: { x: -0.4, y: 0, z: 0 },
        hammer: zeroTransform,
        eyeScaleY,
        visorIntensity: 1.1 + Math.sin(t * 6) * 0.3,
        thoughtOrbit: t * 2.5,
        sparkActive: false,
      };

    case 'speaking':
      const nod = Math.sin(t * 6.5) * (0.04 + 0.06 * act);
      return {
        rootY: Math.sin(t * 4) * 0.02,
        hips: zeroTransform,
        torso: { x: nod * 0.4, y: 0, z: 0 },
        neck: zeroTransform,
        head: { x: nod + typing * 0.12, y: Math.sin(t * 2) * 0.04, z: 0 },
        leftShoulder: zeroTransform,
        leftUpperArm: { x: 0, y: 0, z: 0.25 },
        leftLowerArm: { x: -0.2, y: 0, z: 0 },
        rightShoulder: zeroTransform,
        rightUpperArm: { x: -0.05, y: 0, z: -0.3 },
        rightLowerArm: { x: -0.2, y: 0, z: 0 },
        hammer: zeroTransform,
        eyeScaleY,
        visorIntensity: 1.0 + 0.8 * act + Math.sin(t * 8) * 0.2,
        thoughtOrbit: 0,
        sparkActive: false,
      };

    case 'reviewing':
      return {
        rootY: -0.02,
        hips: zeroTransform,
        torso: { x: 0.14, y: 0.08, z: 0 },
        neck: zeroTransform,
        head: { x: 0.26 + typing * 0.1, y: Math.sin(t * 1.8) * 0.05, z: -0.04 },
        leftShoulder: zeroTransform,
        leftUpperArm: { x: 0, y: 0, z: 0.3 },
        leftLowerArm: { x: -0.3, y: 0, z: 0 },
        rightShoulder: zeroTransform,
        // Arm points toward the changes list
        rightUpperArm: { x: -0.65, y: -0.25, z: -0.2 },
        rightLowerArm: { x: -0.35, y: 0, z: 0 },
        hammer: { x: 0.2, y: 0, z: 0 },
        eyeScaleY,
        visorIntensity: 1.35,
        thoughtOrbit: 0,
        sparkActive: false,
      };

    case 'alert':
      return {
        rootY: 0.05,
        hips: zeroTransform,
        torso: { x: -0.06, y: 0, z: 0 },
        neck: zeroTransform,
        head: { x: -0.15, y: Math.sin(t * 22) * 0.06, z: 0 },
        leftShoulder: zeroTransform,
        leftUpperArm: { x: 0, y: 0, z: 0.4 },
        leftLowerArm: { x: -0.5, y: 0, z: 0 },
        rightShoulder: zeroTransform,
        rightUpperArm: { x: -0.35, y: 0, z: -0.6 },
        rightLowerArm: { x: -0.4, y: 0, z: 0 },
        hammer: zeroTransform,
        eyeScaleY,
        visorIntensity: 1.5 + Math.sin(t * 14) * 0.4,
        thoughtOrbit: 0,
        sparkActive: false,
      };

    case 'success':
      const hop = Math.abs(Math.sin(t * 4)) * 0.09;
      return {
        rootY: hop,
        hips: zeroTransform,
        torso: { x: -0.05, y: 0, z: 0 },
        neck: zeroTransform,
        head: { x: -0.12, y: Math.sin(t * 3) * 0.05, z: 0 },
        leftShoulder: zeroTransform,
        leftUpperArm: { x: 0, y: 0, z: 0.5 },
        leftLowerArm: { x: -0.6, y: 0, z: 0 },
        rightShoulder: zeroTransform,
        // Hammer held high in triumph
        rightUpperArm: { x: -0.3, y: 0, z: -1.35 },
        rightLowerArm: { x: -0.2, y: 0, z: 0 },
        hammer: { x: 0, y: 0, z: -0.3 },
        eyeScaleY,
        visorIntensity: 1.4 + Math.sin(t * 6) * 0.3,
        thoughtOrbit: 0,
        sparkActive: true,
      };
  }
}
