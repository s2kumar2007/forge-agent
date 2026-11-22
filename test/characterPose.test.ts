import { describe, it, expect } from 'vitest';
import {
  computeStatePose,
  blendPoses,
  easeInOutQuad,
  easeOutCubic,
  lerp,
} from '../src/panel/character/characterPose';
import type { CharacterState } from '../src/panel/character/characterState';

describe('Pure Character Pose & Blending Engine', () => {
  const allStates: CharacterState[] = [
    'idle',
    'listening',
    'thinking',
    'speaking',
    'reviewing',
    'alert',
    'success',
  ];

  it('computes valid joint angles for all 7 states without throwing', () => {
    for (const state of allStates) {
      const pose = computeStatePose(state, 1.0);
      expect(typeof pose.rootY).toBe('number');
      expect(typeof pose.torso.x).toBe('number');
      expect(typeof pose.head.x).toBe('number');
      expect(typeof pose.leftUpperArm.z).toBe('number');
      expect(typeof pose.rightUpperArm.z).toBe('number');
      expect(typeof pose.visorIntensity).toBe('number');
      expect(typeof pose.eyeScaleY).toBe('number');
    }
  });

  it('applies distinct characteristic joint rotations per state', () => {
    const idle = computeStatePose('idle', 0);
    const reviewing = computeStatePose('reviewing', 0);
    const success = computeStatePose('success', 0);
    const thinking = computeStatePose('thinking', 0);
    const listening = computeStatePose('listening', 0);

    // Reviewing points arm forward toward changes
    expect(reviewing.rightUpperArm.x).toBeLessThan(idle.rightUpperArm.x);
    expect(reviewing.head.x).toBeGreaterThan(idle.head.x); // leans forward

    // Success raises hammer high
    expect(success.rightUpperArm.z).toBeLessThan(-1.0);
    expect(success.sparkActive).toBe(true);

    // Thinking has orbiting thought spheres
    expect(thinking.thoughtOrbit).toBeGreaterThanOrEqual(0);
    expect(thinking.head.y).toBeLessThan(0); // tilted sideways

    // Listening leans forward attentively
    expect(listening.head.x).toBeLessThan(0);
    expect(listening.head.z).toBeGreaterThan(0);
  });

  it('blends between two joint poses smoothly using blendPoses', () => {
    const poseA = computeStatePose('idle', 0);
    const poseB = computeStatePose('success', 0);

    const mid = blendPoses(poseA, poseB, 0.5);

    expect(mid.rootY).toBeCloseTo(lerp(poseA.rootY, poseB.rootY, 0.5), 4);
    expect(mid.rightUpperArm.z).toBeCloseTo(lerp(poseA.rightUpperArm.z, poseB.rightUpperArm.z, 0.5), 4);
    expect(mid.head.x).toBeCloseTo(lerp(poseA.head.x, poseB.head.x, 0.5), 4);
  });

  it('handles typing focus by pitching the head forward toward prompt box', () => {
    const neutralPose = computeStatePose('idle', 0, { isTyping: 0 });
    const typingPose = computeStatePose('idle', 0, { isTyping: 1 });

    expect(typingPose.head.x).toBeGreaterThan(neutralPose.head.x);
  });

  it('handles eye blinking by compressing eyeScaleY', () => {
    const openEyePose = computeStatePose('idle', 0, { blink: 0 });
    const blinkingPose = computeStatePose('idle', 0, { blink: 1 });

    expect(openEyePose.eyeScaleY).toBe(1.0);
    expect(blinkingPose.eyeScaleY).toBeCloseTo(0.05, 2);
  });

  it('speaking activity increases head nod and visor intensity', () => {
    const quietPose = computeStatePose('speaking', 0.5, { activity: 0 });
    const loudPose = computeStatePose('speaking', 0.5, { activity: 1 });

    expect(loudPose.visorIntensity).toBeGreaterThan(quietPose.visorIntensity);
  });

  it('easing helpers return expected boundary and interpolation values', () => {
    expect(easeInOutQuad(0)).toBe(0);
    expect(easeInOutQuad(1)).toBe(1);
    expect(easeInOutQuad(0.5)).toBe(0.5);

    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});
