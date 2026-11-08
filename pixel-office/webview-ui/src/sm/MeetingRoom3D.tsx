/**
 * The conference room in three.js: a real room with a big wall monitor that plays the meeting's video,
 * a long table with the crew sitting round it and the host (ARES) standing by the screen. The owner
 * sits at the far end of the table looking at the monitor. Self-contained; the <video> is owned by the caller.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';

interface Props {
  video: HTMLVideoElement | null;
  /** Crew ids sitting at the table (the host stands by the monitor). */
  crew: Array<{ id: string; name: string }>;
  host: string;
  by: string | null;
  title: string;
  /** Id of whoever is presenting right now, to bob their head. */
  talking: boolean;
}

const hue = (id: string) => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360; return h / 360; };
const box = (w: number, h: number, d: number, color: THREE.ColorRepresentation, x: number, y: number, z: number) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
  m.position.set(x, y, z);
  return m;
};

function person(id: string, standing: boolean, gold: boolean): THREE.Group {
  const g = new THREE.Group();
  const shirt = new THREE.Color().setHSL(gold ? 0.12 : hue(id), 0.55, gold ? 0.5 : 0.45);
  const legH = standing ? 0.8 : 0.45;
  g.add(box(0.5, 0.7, 0.3, shirt, 0, legH + 0.35, 0));
  g.add(box(0.4, legH, 0.25, 0x33384a, 0, legH / 2, 0));
  const head = box(0.34, 0.34, 0.34, 0xe8c39e, 0, legH + 0.9, 0);
  head.name = 'head';
  g.add(head);
  g.add(box(0.36, 0.12, 0.36, new THREE.Color().setHSL(hue(`${id}h`), 0.4, 0.22), 0, legH + 1.1, -0.01));
  return g;
}

export function MeetingRoom3D({ video, crew, host, by, title, talking }: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const crewKey = crew.map((c) => c.id).join(',');
  const talkRef = useRef(talking);
  talkRef.current = talking;
  useEffect(() => {
    const el = mount.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14141f);
    const cam = new THREE.PerspectiveCamera(52, 1, 0.1, 60);
    cam.position.set(0, 2.7, 6.9);
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const lamp = new THREE.PointLight(0xfff1d0, 0.8, 30);
    lamp.position.set(0, 3.2, 0);
    scene.add(lamp);
    // room shell
    const floor = box(10, 0.1, 14, 0x4a4660, 0, -0.05, 0);
    scene.add(floor, box(10, 3.6, 0.2, 0x2c2c44, 0, 1.8, -6.9), box(0.2, 3.6, 14, 0x34344f, -5, 1.8, 0), box(0.2, 3.6, 14, 0x34344f, 5, 1.8, 0), box(10, 0.1, 14, 0x24243a, 0, 3.6, 0));
    // wall monitor
    const screenTex: THREE.Texture = (() => {
      if (video) { const t = new THREE.VideoTexture(video); t.colorSpace = THREE.SRGBColorSpace; return t; }
      const c = document.createElement('canvas'); c.width = 640; c.height = 360;
      const x = c.getContext('2d');
      if (x) { x.fillStyle = new THREE.Color(0x10131f).getStyle(); x.fillRect(0, 0, 640, 360); x.fillStyle = new THREE.Color(0xe8d98a).getStyle(); x.font = 'bold 34px monospace'; x.textAlign = 'center'; x.fillText(title.slice(0, 28), 320, 180); }
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    scene.add(box(6.5, 3.8 * 0.62 + 0.3, 0.15, 0x0a0a0f, 0, 2.0, -6.75));
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 3.5 * 0.62 + 0.0), new THREE.MeshBasicMaterial({ map: screenTex }));
    screen.position.set(0, 2.0, -6.66);
    scene.add(screen);
    // table + chairs + people
    scene.add(box(2.2, 0.1, 7, 0x6b4a32, 0, 0.8, -0.5), box(0.15, 0.8, 0.15, 0x3a2a1c, -0.9, 0.4, -3.6), box(0.15, 0.8, 0.15, 0x3a2a1c, 0.9, 0.4, -3.6), box(0.15, 0.8, 0.15, 0x3a2a1c, -0.9, 0.4, 2.6), box(0.15, 0.8, 0.15, 0x3a2a1c, 0.9, 0.4, 2.6));
    const seated = crew.filter((c) => c.id !== host).sort((a, b) => Number(b.id === by) - Number(a.id === by)).slice(0, 12);
    const heads: THREE.Object3D[] = [];
    seated.forEach((c, i) => {
      const side = i % 2 === 0 ? -1 : 1;
      const z = -3 + Math.floor(i / 2) * 1.5;
      const p = person(c.id, false, c.id === by);
      p.position.set(side * 1.6, 0, z);
      p.rotation.y = -side * Math.PI / 2;
      scene.add(p, box(0.6, 0.08, 0.6, 0x2a2a3a, side * 1.6, 0.45, z));
      heads.push(p.getObjectByName('head') as THREE.Object3D);
    });
    const ares = person(host, true, true);
    ares.position.set(-3.4, 0, -5.4);
    ares.rotation.y = 0.5;
    scene.add(ares);
    const aresHead = ares.getObjectByName('head') as THREE.Object3D;
    const resize = () => { const w = el.clientWidth || 640, h = el.clientHeight || 360; renderer.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    let raf = 0;
    const t0 = performance.now();
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      cam.position.x = Math.sin(t * 0.25) * 0.8;
      cam.lookAt(0, 1.4, -4.5);
      aresHead.position.y = 1.7 + (talkRef.current ? Math.abs(Math.sin(t * 6)) * 0.05 : 0);
      heads.forEach((h, i) => { h.rotation.y = Math.sin(t * 0.6 + i) * 0.25; });
      renderer.render(scene, cam);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); const mat = m.material as THREE.Material | undefined; mat?.dispose(); });
      screenTex.dispose(); renderer.dispose(); renderer.domElement.remove();
    };
  }, [video, crewKey, host, by, title]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={mount} className="w-full h-full min-h-[320px]" data-testid="sm-meeting-3d" />;
}
