import { useEffect, useRef } from 'react';
import * as THREE from 'three';

export default function DataSphere() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mountElement = mountRef.current;
    if (!mountElement) return;
    const mount: HTMLDivElement = mountElement;

    const W = mount.clientWidth;
    const H = mount.clientHeight;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 200);
    camera.position.set(0, 0, 7);
    camera.lookAt(0, 0, 0);

    // ── Cyberpunk cyan/green palette ──────────────────────────────
    const GOLD        = 0x00d4ff;  // cyan
    const GOLD_BRIGHT = 0x00ff88;  // green
    const SILVER      = 0x00ccff;  // light cyan
    const ROSE_GOLD   = 0x00ff88;  // green
    const AMBER       = 0x006688;  // deep cyan
    const WARM_WHITE  = 0x88eeff;  // ice cyan

    // Outer atmosphere — very faint gold halo
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.9, 20, 20),
      new THREE.MeshBasicMaterial({
        color: GOLD,
        transparent: true,
        opacity: 0.035,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.BackSide,
      })
    );
    scene.add(atmosphere);

    // ── Main wireframe — gold icosahedron ─────────────────────────
    const icoGeo = new THREE.IcosahedronGeometry(1.35, 2);
    const edgesGeo = new THREE.EdgesGeometry(icoGeo);
    const wireframe = new THREE.LineSegments(edgesGeo, new THREE.LineBasicMaterial({
      color: GOLD,
      transparent: true,
      opacity: 0.32,
    }));
    scene.add(wireframe);

    // Outer shell — silver
    const outerEdges = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.52, 1));
    const outerShell = new THREE.LineSegments(outerEdges, new THREE.LineBasicMaterial({
      color: SILVER,
      transparent: true,
      opacity: 0.10,
    }));
    scene.add(outerShell);

    // Core glow — deep amber
    const coreGlow = new THREE.Mesh(
      new THREE.SphereGeometry(0.80, 20, 20),
      new THREE.MeshBasicMaterial({
        color: AMBER,
        transparent: true,
        opacity: 0.10,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.BackSide,
      })
    );
    scene.add(coreGlow);

    // Inner core — warm white, strong pulse
    const innerCore = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 12, 12),
      new THREE.MeshBasicMaterial({
        color: WARM_WHITE,
        transparent: true,
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    scene.add(innerCore);

    // ── Surface particle cloud — gold ↔ silver ────────────────────
    const SURF_N = 480;
    const surfPos    = new Float32Array(SURF_N * 3);
    const surfColors = new Float32Array(SURF_N * 3);
    const cA = new THREE.Color(GOLD);
    const cB = new THREE.Color(SILVER);

    for (let i = 0; i < SURF_N; i++) {
      const theta = Math.acos(1 - 2 * Math.random());
      const phi   = Math.random() * Math.PI * 2;
      const r     = 1.35 + (Math.random() - 0.5) * 0.1;
      surfPos[i * 3]     = r * Math.sin(theta) * Math.cos(phi);
      surfPos[i * 3 + 1] = r * Math.sin(theta) * Math.sin(phi);
      surfPos[i * 3 + 2] = r * Math.cos(theta);
      const mix = new THREE.Color().lerpColors(cA, cB, Math.random());
      surfColors[i * 3]     = mix.r;
      surfColors[i * 3 + 1] = mix.g;
      surfColors[i * 3 + 2] = mix.b;
    }
    const surfGeo = new THREE.BufferGeometry();
    surfGeo.setAttribute('position', new THREE.BufferAttribute(surfPos, 3));
    surfGeo.setAttribute('color',    new THREE.BufferAttribute(surfColors, 3));
    const surfParticles = new THREE.Points(surfGeo, new THREE.PointsMaterial({
      size: 0.024,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    }));
    scene.add(surfParticles);

    // ── Orbital rings — gold / silver / rose-gold ─────────────────
    const ORBIT_DEFS = [
      { radius: 2.30, incX: 0,            incZ: 0,           speed:  0.38, color: GOLD,      pts: 4 },
      { radius: 2.75, incX: Math.PI/2.8,  incZ: Math.PI/8,   speed: -0.28, color: SILVER,    pts: 3 },
      { radius: 3.20, incX: Math.PI/1.7,  incZ: -Math.PI/6,  speed:  0.19, color: ROSE_GOLD, pts: 5 },
    ];

    const orbitSystems = ORBIT_DEFS.map(def => {
      const pivot = new THREE.Group();
      pivot.rotation.x = def.incX;
      pivot.rotation.z = def.incZ;
      scene.add(pivot);

      const ringPts: Array<ReturnType<typeof THREE.Vector3>> = [];
      for (let i = 0; i <= 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        ringPts.push(new THREE.Vector3(Math.cos(a) * def.radius, 0, Math.sin(a) * def.radius));
      }
      pivot.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(ringPts),
        new THREE.LineBasicMaterial({ color: def.color, transparent: true, opacity: 0.13 })
      ));

      const nodes: {
        group: ReturnType<typeof THREE.Group>;
        angle: number;
        radius: number;
      }[] = [];
      for (let i = 0; i < def.pts; i++) {
        const nodeGroup = new THREE.Group();

        nodeGroup.add(new THREE.Mesh(
          new THREE.SphereGeometry(0.09, 8, 8),
          new THREE.MeshBasicMaterial({
            color: def.color,
            transparent: true,
            opacity: 0.28,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          })
        ));
        nodeGroup.add(new THREE.Mesh(
          new THREE.SphereGeometry(0.028, 7, 7),
          new THREE.MeshBasicMaterial({ color: WARM_WHITE, transparent: true, opacity: 0.92 })
        ));

        pivot.add(nodeGroup);
        nodes.push({ group: nodeGroup, angle: (i / def.pts) * Math.PI * 2, radius: def.radius });
      }

      return { pivot, nodes, speed: def.speed };
    });

    // ── Ambient starfield — gold dust ─────────────────────────────
    const FLOAT_N = 320;
    const floatPos = new Float32Array(FLOAT_N * 3);
    for (let i = 0; i < FLOAT_N; i++) {
      floatPos[i * 3]     = (Math.random() - 0.5) * 14;
      floatPos[i * 3 + 1] = (Math.random() - 0.5) * 10;
      floatPos[i * 3 + 2] = (Math.random() - 0.5) * 8 - 1;
    }
    const floatGeo = new THREE.BufferGeometry();
    floatGeo.setAttribute('position', new THREE.BufferAttribute(floatPos, 3));
    scene.add(new THREE.Points(floatGeo, new THREE.PointsMaterial({
      color: GOLD_BRIGHT,
      size: 0.016,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    })));

    // ── Animation loop ────────────────────────────────────────────
    const timer = new THREE.Timer();

    renderer.setAnimationLoop(() => {
      timer.update();
      const delta = timer.getDelta();
      const elapsed = timer.getElapsed();

      wireframe.rotation.x = elapsed * 0.07;
      wireframe.rotation.y = elapsed * 0.11;
      outerShell.rotation.x = -elapsed * 0.05;
      outerShell.rotation.y =  elapsed * 0.08;
      surfParticles.rotation.y = elapsed * 0.06;
      surfParticles.rotation.x = elapsed * 0.04;
      atmosphere.rotation.y = elapsed * 0.04;

      const pulse = 0.9 + Math.sin(elapsed * 1.6) * 0.1;
      innerCore.scale.setScalar(pulse);
      (innerCore.material as { opacity: number }).opacity = 0.58 + Math.sin(elapsed * 1.6) * 0.14;
      (coreGlow.material as { opacity: number }).opacity  = 0.08 + Math.sin(elapsed * 0.8) * 0.03;

      orbitSystems.forEach(({ nodes, speed }) => {
        nodes.forEach(node => {
          node.angle += speed * delta;
          node.group.position.set(
            Math.cos(node.angle) * node.radius,
            0,
            Math.sin(node.angle) * node.radius
          );
          const np = 0.8 + Math.sin(elapsed * 2.2 + node.angle) * 0.2;
          node.group.scale.setScalar(np);
        });
      });

      camera.position.x = Math.sin(elapsed * 0.14) * 0.25;
      camera.position.y = Math.cos(elapsed * 0.19) * 0.18;
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    });

    // ── Resize ────────────────────────────────────────────────────
    function onResize() {
      const nW = mount.clientWidth;
      const nH = mount.clientHeight;
      camera.aspect = nW / nH;
      camera.updateProjectionMatrix();
      renderer.setSize(nW, nH);
    }
    window.addEventListener('resize', onResize);

    return () => {
      renderer.setAnimationLoop(null);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      if (mount.contains(renderer.domElement)) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div
      ref={mountRef}
      style={{
        position: 'fixed',
        top: 0, left: 0,
        width: '100%', height: '100%',
        pointerEvents: 'none',
        zIndex: 0,
        opacity: 0.72,
      }}
    />
  );
}
