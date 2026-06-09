import { useEffect, useRef } from 'react';
import * as THREE from 'three';

export interface WarpTrigger {
  key: number;
  direction: 'LONG' | 'SHORT';
  intensity: number; // 0–1
}

interface Props {
  trigger: WarpTrigger | null;
}

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;
uniform float uTime;
uniform float uIntensity;
uniform float uDirection; // 1.0 = LONG (cyan-green), -1.0 = SHORT (red-orange)
uniform float uFade;
varying vec2 vUv;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  vec2 uv = vUv - 0.5;
  uv.x *= 1.7778; // 16:9

  float dist = length(uv);
  if (dist < 0.001) { gl_FragColor = vec4(0.0); return; }

  float angle = atan(uv.y, uv.x);

  // Hyperspace tunnel rings
  float speed = mix(1.8, 5.5, uIntensity);
  float z = 0.42 / (dist + 0.003);
  float depth = fract(z - uTime * speed);

  // Radial streaks
  float slices  = 54.0;
  float sliceId = floor(fract(angle / 6.28318) * slices);
  float sliceRnd   = hash(sliceId * 13.7 + 5.9);
  float brightness0 = hash(sliceId * 7.3  + 1.1);
  float sliceActive = step(0.28, sliceRnd);

  // Streak shape — bright front, dark rear
  float streak = pow(depth, 1.3) * (1.0 - depth * 0.6);
  streak *= sliceActive * brightness0;

  // Falloff from center
  float radialFade = 1.0 - smoothstep(0.0, 0.52, dist);
  float coreBright  = (1.0 - smoothstep(0.0, 0.07, dist)) * 3.2;

  // Color palette
  float t = (uDirection + 1.0) * 0.5; // 0 = SHORT, 1 = LONG
  vec3 longFar   = vec3(0.0,  0.85, 1.0);   // ice-cyan
  vec3 longNear  = vec3(0.0,  1.0,  0.55);  // green
  vec3 shortFar  = vec3(1.0,  0.42, 0.0);   // orange
  vec3 shortNear = vec3(1.0,  0.08, 0.02);  // red
  vec3 colFar    = mix(shortFar,  longFar,  t);
  vec3 colNear   = mix(shortNear, longNear, t);
  vec3 color     = mix(colFar, colNear, depth);

  float bright = (streak * radialFade + coreBright * radialFade * 0.32) * uIntensity * 2.4;
  float alpha  = bright * uFade;

  gl_FragColor = vec4(color * bright, clamp(alpha, 0.0, 0.88));
}
`;

export default function PriceWarpEffect({ trigger }: Props) {
  const canvasRef   = useRef<HTMLCanvasElement | null>(null);
  const uniformsRef = useRef<Record<string, { value: unknown }> | null>(null);
  const clockRef    = useRef(new THREE.Clock(false));
  const animRef     = useRef(0);
  const stateRef    = useRef({
    active:    false,
    startTime: 0,
    duration:  3800, // ms
    direction: 1.0,
    intensity: 1.0,
  });

  // Init renderer once
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);

    const scene  = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const uniforms: Record<string, { value: unknown }> = {
      uTime:      { value: 0 },
      uIntensity: { value: 0 },
      uDirection: { value: 1.0 },
      uFade:      { value: 0 },
    };
    uniformsRef.current = uniforms;

    const mat = new THREE.ShaderMaterial({
      vertexShader:   VERT,
      fragmentShader: FRAG,
      uniforms,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    scene.add(mesh);

    const onResize = () =>
      renderer.setSize(window.innerWidth, window.innerHeight, false);
    window.addEventListener('resize', onResize);
    clockRef.current.start();

    const animate = () => {
      animRef.current = requestAnimationFrame(animate);
      const u     = uniformsRef.current!;
      const state = stateRef.current;
      u.uTime.value = clockRef.current.getElapsedTime();

      if (state.active) {
        const elapsed   = performance.now() - state.startTime;
        const progress  = Math.min(1, elapsed / state.duration);
        if (progress >= 1.0) {
          state.active       = false;
          u.uFade.value      = 0;
          u.uIntensity.value = 0;
        } else {
          u.uDirection.value  = state.direction;
          u.uIntensity.value  = state.intensity;
          const fadeIn  = Math.min(1, progress / 0.12);
          const fadeOut = 1 - Math.max(0, (progress - 0.60) / 0.40);
          u.uFade.value = fadeIn * fadeOut;
        }
      }

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener('resize', onResize);
      mat.dispose();
      renderer.dispose();
    };
  }, []);

  // Fire effect on each new trigger
  useEffect(() => {
    if (!trigger) return;
    const state      = stateRef.current;
    state.active     = true;
    state.startTime  = performance.now();
    state.direction  = trigger.direction === 'LONG' ? 1.0 : -1.0;
    state.intensity  = Math.max(0.4, Math.min(1.0, trigger.intensity));
  }, [trigger]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position:      'fixed',
        top:           0,
        left:          0,
        width:         '100%',
        height:        '100%',
        pointerEvents: 'none',
        zIndex:        1,
      }}
    />
  );
}