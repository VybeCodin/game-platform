"use client";

import { useEffect, useRef, useState } from "react";

type Vec = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

type Platform = Rect & { hue: number; phase: number };
type Enemy = Rect & {
  vx: number;
  minX: number;
  maxX: number;
  alive: boolean;
  squashT: number;
  hue: number;
};
type Coin = { x: number; y: number; r: number; collected: boolean; phase: number };
type Particle = {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; color: string; size: number;
};

const VIEW_W = 960;
const VIEW_H = 540;
const GROUND_Y = 460; // sea level (water surface)
const GRAVITY = 0.55;
const MOVE_SPEED = 4.6;
const AIR_ACCEL = 0.45;
const JUMP_V = -11.6;
const DOUBLE_JUMP_V = -10.2;
const MAX_FALL = 16;
const MAX_HSPEED = 5.4;

export default function PlatformerGame() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [hud, setHud] = useState({ score: 0, best: 0, state: "title" as "title" | "playing" | "dead" });

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;

    // ----- Audio (Web Audio API synth) -----
    let audio: AudioContext | null = null;
    const ensureAudio = () => {
      if (!audio) {
        const Ctor = (window.AudioContext || (window as any).webkitAudioContext);
        if (Ctor) audio = new Ctor();
      }
      return audio;
    };
    const playTone = (
      freq: number, dur: number, type: OscillatorType = "square",
      vol = 0.06, slideTo?: number
    ) => {
      const a = ensureAudio();
      if (!a) return;
      const t = a.currentTime;
      const osc = a.createOscillator();
      const gain = a.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(vol, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(a.destination);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    };
    const sfx = {
      jump: () => playTone(520, 0.14, "square", 0.05, 880),
      doubleJump: () => playTone(720, 0.16, "triangle", 0.06, 1200),
      stomp: () => { playTone(180, 0.08, "square", 0.07, 80); playTone(420, 0.1, "triangle", 0.05, 220); },
      coin: () => { playTone(880, 0.06, "triangle", 0.05); setTimeout(() => playTone(1320, 0.09, "triangle", 0.05), 50); },
      death: () => { playTone(440, 0.18, "sawtooth", 0.07, 110); setTimeout(() => playTone(220, 0.3, "sawtooth", 0.07, 60), 120); },
      start: () => { playTone(523, 0.08, "triangle", 0.05); setTimeout(() => playTone(659, 0.08, "triangle", 0.05), 80); setTimeout(() => playTone(880, 0.14, "triangle", 0.06), 160); },
    };

    // ----- Game state -----
    type State = "title" | "playing" | "dead";
    let state: State = "title";
    let bestScore = Number(localStorage.getItem("neon-cove-best") || "0");
    setHud((h) => ({ ...h, best: bestScore }));

    const player = {
      x: 120, y: 200, w: 26, h: 32,
      vx: 0, vy: 0,
      onGround: false,
      jumps: 0, // 0 = fresh, 1 = jumped, 2 = double-jumped
      facing: 1,
      hurtT: 0,
      animT: 0,
      stretch: 0,
    };

    let platforms: Platform[] = [];
    let enemies: Enemy[] = [];
    let coins: Coin[] = [];
    let particles: Particle[] = [];

    let camX = 0;
    let furthestX = 0;
    let score = 0;
    let scoreFloat = 0;
    let stompCombo = 0;
    let stompComboT = 0;
    let timeT = 0;
    let shakeT = 0;
    let deathT = 0;
    let titleT = 0;

    const keys = new Set<string>();
    let jumpPressedThisFrame = false;
    let restartPressed = false;

    // ----- World generation -----
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    const irand = (a: number, b: number) => Math.floor(rand(a, b + 1));

    const spawnEnemy = (p: Platform) => {
      const w = 28, h = 22;
      const ex = p.x + 10 + Math.random() * (p.w - 20 - w);
      enemies.push({
        x: ex, y: p.y - h,
        w, h,
        vx: (Math.random() < 0.5 ? -1 : 1) * rand(0.6, 1.2),
        minX: p.x + 4, maxX: p.x + p.w - 4 - w,
        alive: true, squashT: 0,
        hue: rand(280, 340),
      });
    };

    const spawnCoinsAbove = (p: Platform) => {
      const n = irand(2, 5);
      const cx = p.x + p.w / 2;
      for (let i = 0; i < n; i++) {
        coins.push({
          x: cx + (i - (n - 1) / 2) * 22,
          y: p.y - 40 - Math.sin(i / (n - 1 || 1) * Math.PI) * 30,
          r: 7,
          collected: false,
          phase: Math.random() * Math.PI * 2,
        });
      }
    };

    const generateNext = () => {
      let lastX = platforms.length ? platforms[platforms.length - 1].x + platforms[platforms.length - 1].w : 0;
      let lastY = platforms.length ? platforms[platforms.length - 1].y : GROUND_Y - 80;
      const targetX = camX + VIEW_W + 600;
      while (lastX < targetX) {
        const gap = rand(70, 160);
        const w = rand(90, 180);
        let y = lastY + rand(-90, 90);
        y = Math.max(170, Math.min(GROUND_Y - 60, y));
        const p: Platform = {
          x: lastX + gap,
          y,
          w,
          h: 18,
          hue: rand(180, 320),
          phase: Math.random() * Math.PI * 2,
        };
        platforms.push(p);
        if (Math.random() < 0.45 && p.w > 90) spawnEnemy(p);
        if (Math.random() < 0.55) spawnCoinsAbove(p);
        lastX = p.x + p.w;
        lastY = p.y;
      }
    };

    const resetGame = () => {
      platforms = [];
      enemies = [];
      coins = [];
      particles = [];
      camX = 0;
      furthestX = 0;
      score = 0;
      scoreFloat = 0;
      stompCombo = 0;
      stompComboT = 0;
      shakeT = 0;
      deathT = 0;
      // Starting platform
      platforms.push({ x: 60, y: GROUND_Y - 80, w: 240, h: 18, hue: 200, phase: 0 });
      // A few easy follow-ups
      let lx = 300;
      let ly = GROUND_Y - 80;
      for (let i = 0; i < 4; i++) {
        const w = rand(110, 170);
        const y = Math.max(220, Math.min(GROUND_Y - 60, ly + rand(-50, 50)));
        platforms.push({ x: lx + rand(80, 130), y, w, h: 18, hue: rand(180, 320), phase: Math.random() * 6 });
        lx = platforms[platforms.length - 1].x + w;
        ly = y;
      }
      generateNext();
      player.x = 120;
      player.y = platforms[0].y - player.h - 1;
      player.vx = 0;
      player.vy = 0;
      player.onGround = true;
      player.jumps = 0;
      player.hurtT = 0;
      player.facing = 1;
    };

    // ----- Input -----
    const onKeyDown = (e: KeyboardEvent) => {
      // Prevent page scroll on space/arrows
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)) e.preventDefault();
      const k = e.key.toLowerCase();
      if (!keys.has(k)) {
        if (k === " " || k === "arrowup" || k === "w") jumpPressedThisFrame = true;
        if ((k === "enter" || k === " ") && (state === "title" || state === "dead")) {
          restartPressed = true;
        }
      }
      keys.add(k);
    };
    const onKeyUp = (e: KeyboardEvent) => { keys.delete(e.key.toLowerCase()); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Touch / pointer for mobile
    const pointerState = { left: false, right: false };
    const handleTouchJump = () => { jumpPressedThisFrame = true; if (state === "title" || state === "dead") restartPressed = true; };

    const onPointerDown = (e: PointerEvent) => {
      ensureAudio()?.resume();
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      if (y < 0.6) {
        handleTouchJump();
      } else {
        if (x < 0.5) pointerState.left = true; else pointerState.right = true;
      }
    };
    const onPointerUp = () => { pointerState.left = false; pointerState.right = false; };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerUp);

    // ----- Helpers -----
    const aabb = (a: Rect, b: Rect) =>
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

    const burst = (x: number, y: number, color: string, n = 12, speed = 4) => {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = rand(0.5, 1) * speed;
        particles.push({
          x, y,
          vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1,
          life: 0, maxLife: rand(20, 40), color,
          size: rand(2, 4),
        });
      }
    };

    const die = () => {
      if (state !== "playing") return;
      state = "dead";
      deathT = 0;
      shakeT = 22;
      sfx.death();
      burst(player.x + player.w / 2, player.y + player.h / 2, "#ff3aa6", 32, 6);
      if (Math.floor(score) > bestScore) {
        bestScore = Math.floor(score);
        localStorage.setItem("neon-cove-best", String(bestScore));
      }
      setHud({ score: Math.floor(score), best: bestScore, state: "dead" });
    };

    // ----- Update -----
    const update = (dt: number) => {
      timeT += dt;
      titleT += dt;

      if (state === "title") {
        if (restartPressed || keys.has("enter") || keys.has(" ")) {
          restartPressed = false;
          ensureAudio()?.resume();
          sfx.start();
          state = "playing";
          resetGame();
          setHud({ score: 0, best: bestScore, state: "playing" });
        }
        jumpPressedThisFrame = false;
        return;
      }

      if (state === "dead") {
        deathT += dt;
        if ((restartPressed || keys.has("enter")) && deathT > 0.6) {
          restartPressed = false;
          ensureAudio()?.resume();
          sfx.start();
          state = "playing";
          resetGame();
          setHud({ score: 0, best: bestScore, state: "playing" });
        }
        // continue particle/shake updates
        for (const p of particles) {
          p.x += p.vx; p.y += p.vy; p.vy += 0.18; p.life++;
        }
        particles = particles.filter((p) => p.life < p.maxLife);
        if (shakeT > 0) shakeT--;
        jumpPressedThisFrame = false;
        return;
      }

      // ----- Playing -----
      const left = keys.has("arrowleft") || keys.has("a") || pointerState.left;
      const right = keys.has("arrowright") || keys.has("d") || pointerState.right;

      // Horizontal movement
      const accel = player.onGround ? 1.0 : AIR_ACCEL / 0.45 * 0.6;
      const target = (right ? 1 : 0) - (left ? 1 : 0);
      if (target !== 0) {
        player.vx += target * accel * 0.9;
        player.facing = target;
      } else {
        player.vx *= player.onGround ? 0.78 : 0.96;
        if (Math.abs(player.vx) < 0.05) player.vx = 0;
      }
      player.vx = Math.max(-MAX_HSPEED, Math.min(MAX_HSPEED, player.vx));
      // Speed-cap: blend toward MOVE_SPEED on ground
      if (player.onGround && target !== 0) {
        player.vx = player.vx * 0.6 + target * MOVE_SPEED * 0.4;
      }

      // Jump
      if (jumpPressedThisFrame) {
        if (player.onGround) {
          player.vy = JUMP_V;
          player.onGround = false;
          player.jumps = 1;
          player.stretch = 0.4;
          sfx.jump();
        } else if (player.jumps < 3) {
          // 2nd jump uses DOUBLE_JUMP_V, 3rd a touch weaker so it feels earned
          const v = player.jumps === 1 ? DOUBLE_JUMP_V : DOUBLE_JUMP_V * 0.92;
          player.vy = v;
          player.jumps += 1;
          player.stretch = 0.6;
          // higher pitch + cyan→magenta puff for the triple jump
          if (player.jumps === 3) {
            playTone(960, 0.18, "triangle", 0.06, 1500);
          } else {
            sfx.doubleJump();
          }
          const puffColor = player.jumps === 3 ? "#ff7ad6" : "#7df9ff";
          for (let i = 0; i < 12; i++) {
            const a = Math.PI + (Math.random() - 0.5) * 0.9;
            particles.push({
              x: player.x + player.w / 2, y: player.y + player.h,
              vx: Math.cos(a) * rand(1, 3), vy: Math.sin(a) * rand(1, 3),
              life: 0, maxLife: 22, color: puffColor, size: 3,
            });
          }
        }
      }

      // Gravity
      player.vy = Math.min(player.vy + GRAVITY, MAX_FALL);

      // Move + collide horizontally
      player.x += player.vx;
      for (const p of platforms) {
        if (aabb(player, p)) {
          if (player.vx > 0) player.x = p.x - player.w;
          else if (player.vx < 0) player.x = p.x + p.w;
          player.vx = 0;
        }
      }
      // Move + collide vertically
      player.y += player.vy;
      let landed = false;
      for (const p of platforms) {
        if (aabb(player, p)) {
          if (player.vy > 0) {
            player.y = p.y - player.h;
            player.vy = 0;
            landed = true;
            player.jumps = 0;
            if (!player.onGround) player.stretch = -0.35; // squash on land
          } else if (player.vy < 0) {
            player.y = p.y + p.h;
            player.vy = 0;
          }
        }
      }
      player.onGround = landed;

      // Enemies
      for (const e of enemies) {
        if (!e.alive) {
          e.squashT += dt;
          continue;
        }
        e.x += e.vx;
        if (e.x < e.minX) { e.x = e.minX; e.vx *= -1; }
        if (e.x > e.maxX) { e.x = e.maxX; e.vx *= -1; }

        if (aabb(player, e)) {
          const playerBottom = player.y + player.h;
          // Stomp condition: falling + player bottom is above enemy mid
          if (player.vy > 1 && playerBottom < e.y + e.h * 0.55) {
            e.alive = false;
            e.squashT = 0;
            stompCombo++;
            stompComboT = 1.4;
            const bonus = 50 * stompCombo;
            score += bonus;
            scoreFloat = bonus;
            player.vy = JUMP_V * 0.85;
            player.jumps = 1; // refresh double jump
            sfx.stomp();
            shakeT = 6;
            burst(e.x + e.w / 2, e.y + e.h / 2, `hsl(${e.hue},100%,65%)`, 18, 5);
          } else {
            die();
            return;
          }
        }
      }
      enemies = enemies.filter((e) => e.squashT < 0.6 && e.x > camX - 200);

      // Coins
      for (const c of coins) {
        if (c.collected) continue;
        c.phase += dt * 4;
        const dx = (player.x + player.w / 2) - c.x;
        const dy = (player.y + player.h / 2) - c.y;
        if (dx * dx + dy * dy < (c.r + 14) ** 2) {
          c.collected = true;
          score += 25;
          scoreFloat = 25;
          sfx.coin();
          burst(c.x, c.y, "#ffe57a", 10, 3);
        }
      }
      coins = coins.filter((c) => !c.collected && c.x > camX - 100);

      // Combo timer
      if (stompComboT > 0) {
        stompComboT -= dt;
        if (stompComboT <= 0) stompCombo = 0;
      }

      // Score from distance
      if (player.x > furthestX) {
        score += (player.x - furthestX) * 0.1;
        furthestX = player.x;
      }

      // Camera follows
      const targetCam = player.x - VIEW_W * 0.32;
      camX += (targetCam - camX) * 0.12;
      if (camX < 0) camX = 0;

      // Generate ahead
      generateNext();

      // Cleanup behind
      platforms = platforms.filter((p) => p.x + p.w > camX - 200);

      // Particles
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.18;
        p.life++;
      }
      particles = particles.filter((p) => p.life < p.maxLife);

      // Stretch decay
      player.stretch *= 0.85;

      // Death by falling
      if (player.y > GROUND_Y + 80) {
        die();
      }

      // HUD update (throttle to ~6 fps to avoid React thrash)
      hudThrottle += dt;
      if (hudThrottle > 0.15) {
        hudThrottle = 0;
        setHud({ score: Math.floor(score), best: bestScore, state: "playing" });
      }

      if (shakeT > 0) shakeT--;
      jumpPressedThisFrame = false;
    };

    let hudThrottle = 0;

    // ----- Drawing -----
    const drawBackground = () => {
      // sky gradient
      const sky = ctx.createLinearGradient(0, 0, 0, VIEW_H);
      sky.addColorStop(0, "#0a0524");
      sky.addColorStop(0.55, "#1a0a44");
      sky.addColorStop(1, "#3a0d5c");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);

      // distant stars
      ctx.save();
      for (let i = 0; i < 60; i++) {
        const sx = ((i * 137.5 - camX * 0.05) % VIEW_W + VIEW_W) % VIEW_W;
        const sy = (i * 53) % 220;
        const tw = 0.5 + 0.5 * Math.sin(timeT * 2 + i);
        ctx.globalAlpha = 0.3 + tw * 0.5;
        ctx.fillStyle = "#fff";
        ctx.fillRect(sx, sy, 1.5, 1.5);
      }
      ctx.restore();

      // neon sun
      const sunX = VIEW_W * 0.7;
      const sunY = 250;
      const sunR = 90;
      const grd = ctx.createRadialGradient(sunX, sunY, 5, sunX, sunY, sunR);
      grd.addColorStop(0, "#fff5b8");
      grd.addColorStop(0.4, "#ff7ad6");
      grd.addColorStop(1, "rgba(255,80,180,0)");
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
      ctx.fill();

      // sun stripes (synthwave)
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      for (let i = 0; i < 6; i++) {
        const y = sunY + 10 + i * 12;
        ctx.fillRect(sunX - sunR, y, sunR * 2, 4 + i);
      }
      ctx.restore();

      // distant ship silhouette
      const shipX = ((-camX * 0.1) % (VIEW_W + 200) + VIEW_W + 200) % (VIEW_W + 200) - 100;
      ctx.save();
      ctx.fillStyle = "rgba(20,5,40,0.9)";
      ctx.translate(shipX, 360 + Math.sin(timeT * 0.7) * 4);
      ctx.beginPath();
      ctx.moveTo(-40, 0); ctx.lineTo(40, 0); ctx.lineTo(30, 12); ctx.lineTo(-30, 12); ctx.closePath();
      ctx.fill();
      ctx.fillRect(-2, -40, 4, 40);
      ctx.beginPath();
      ctx.moveTo(0, -40); ctx.lineTo(20, -10); ctx.lineTo(0, -10); ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, -25); ctx.lineTo(-18, -5); ctx.lineTo(0, -5); ctx.closePath();
      ctx.fill();
      ctx.restore();

      // synthwave grid floor (water)
      ctx.save();
      ctx.strokeStyle = "rgba(0, 240, 255, 0.55)";
      ctx.lineWidth = 1;
      // horizon line
      const horizon = GROUND_Y;
      ctx.shadowColor = "#00f0ff";
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(0, horizon);
      ctx.lineTo(VIEW_W, horizon);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // perspective lines
      const vanishX = VIEW_W / 2 - (camX * 0.3) % 80;
      for (let i = -16; i <= 16; i++) {
        const lx = vanishX + i * 80;
        ctx.beginPath();
        ctx.moveTo(lx, horizon);
        ctx.lineTo(VIEW_W / 2 + (lx - VIEW_W / 2) * 6, VIEW_H + 60);
        ctx.globalAlpha = 0.35;
        ctx.stroke();
      }
      // horizontal grid lines (receding)
      ctx.globalAlpha = 1;
      for (let i = 1; i < 14; i++) {
        const t = i / 14;
        const y = horizon + Math.pow(t, 1.6) * (VIEW_H - horizon + 40);
        ctx.globalAlpha = 0.55 * (1 - t * 0.6);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(VIEW_W, y);
        ctx.stroke();
      }
      ctx.restore();

      // soft water reflection of sun
      ctx.save();
      const refl = ctx.createLinearGradient(0, GROUND_Y, 0, VIEW_H);
      refl.addColorStop(0, "rgba(255,120,200,0.25)");
      refl.addColorStop(1, "rgba(255,120,200,0)");
      ctx.fillStyle = refl;
      ctx.fillRect(sunX - sunR, GROUND_Y, sunR * 2, VIEW_H - GROUND_Y);
      ctx.restore();
    };

    const drawPlatform = (p: Platform) => {
      const x = p.x - camX;
      const bob = Math.sin(timeT * 1.2 + p.phase) * 3;
      const y = p.y + bob;

      ctx.save();
      // glow
      ctx.shadowColor = `hsl(${p.hue},100%,65%)`;
      ctx.shadowBlur = 18;
      // wood plank base
      const grd = ctx.createLinearGradient(x, y, x, y + p.h);
      grd.addColorStop(0, `hsl(${p.hue}, 90%, 30%)`);
      grd.addColorStop(1, `hsl(${p.hue}, 80%, 14%)`);
      ctx.fillStyle = grd;
      roundRect(ctx, x, y, p.w, p.h, 4);
      ctx.fill();

      // top neon edge
      ctx.shadowBlur = 14;
      ctx.strokeStyle = `hsl(${p.hue}, 100%, 70%)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 3, y + 1);
      ctx.lineTo(x + p.w - 3, y + 1);
      ctx.stroke();

      // plank lines
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `hsla(${p.hue},80%,10%,0.7)`;
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const lx = x + (p.w * i) / 4;
        ctx.beginPath();
        ctx.moveTo(lx, y + 3);
        ctx.lineTo(lx, y + p.h - 3);
        ctx.stroke();
      }

      // bolts
      ctx.fillStyle = `hsl(${p.hue}, 100%, 80%)`;
      ctx.shadowColor = `hsl(${p.hue},100%,70%)`;
      ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.arc(x + 5, y + p.h / 2, 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + p.w - 5, y + p.h / 2, 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      // shift baked-in y back so collision keeps using p.y (we only visually bobbed)
    };

    const drawEnemy = (e: Enemy) => {
      const x = e.x - camX;
      const y = e.y;
      ctx.save();
      ctx.shadowColor = `hsl(${e.hue},100%,65%)`;
      ctx.shadowBlur = 16;
      if (!e.alive) {
        // squashed
        const s = Math.max(0, 1 - e.squashT * 2);
        ctx.fillStyle = `hsla(${e.hue},90%,55%,${s})`;
        ctx.fillRect(x, y + e.h - 6, e.w, 6);
        ctx.restore();
        return;
      }
      // body — crab-like blob
      const bob = Math.sin(timeT * 6 + e.x * 0.05) * 1.5;
      ctx.fillStyle = `hsl(${e.hue}, 90%, 40%)`;
      roundRect(ctx, x, y + bob, e.w, e.h, 6);
      ctx.fill();

      // neon outline
      ctx.shadowBlur = 14;
      ctx.strokeStyle = `hsl(${e.hue}, 100%, 70%)`;
      ctx.lineWidth = 2;
      roundRect(ctx, x, y + bob, e.w, e.h, 6);
      ctx.stroke();

      // eyes
      ctx.shadowBlur = 6;
      ctx.fillStyle = "#fff";
      const eyeY = y + bob + 8;
      ctx.beginPath(); ctx.arc(x + 8, eyeY, 3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + e.w - 8, eyeY, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#0a0";
      const look = e.vx > 0 ? 1.2 : -1.2;
      ctx.beginPath(); ctx.arc(x + 8 + look, eyeY, 1.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + e.w - 8 + look, eyeY, 1.4, 0, Math.PI * 2); ctx.fill();

      // legs
      ctx.strokeStyle = `hsl(${e.hue}, 100%, 60%)`;
      ctx.lineWidth = 2;
      const legPhase = Math.sin(timeT * 10 + e.x * 0.1);
      for (let i = 0; i < 3; i++) {
        const lx = x + 4 + i * (e.w - 8) / 2;
        const swing = legPhase * (i % 2 === 0 ? 1 : -1) * 2;
        ctx.beginPath();
        ctx.moveTo(lx, y + bob + e.h);
        ctx.lineTo(lx + swing, y + bob + e.h + 5);
        ctx.stroke();
      }
      ctx.restore();
    };

    const drawCoin = (c: Coin) => {
      if (c.collected) return;
      const x = c.x - camX;
      const y = c.y + Math.sin(c.phase) * 3;
      const sw = Math.abs(Math.cos(c.phase));
      ctx.save();
      ctx.shadowColor = "#ffe57a";
      ctx.shadowBlur = 14;
      ctx.fillStyle = "#ffd24a";
      ctx.beginPath();
      ctx.ellipse(x, y, c.r * sw, c.r, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 6;
      ctx.fillStyle = "#fff7c8";
      ctx.beginPath();
      ctx.ellipse(x - c.r * 0.2, y - c.r * 0.4, c.r * 0.25 * sw, c.r * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    const drawPlayer = () => {
      const x = player.x - camX;
      const y = player.y;
      const stretchY = 1 + player.stretch;
      const stretchX = 1 - player.stretch * 0.5;
      const cx = x + player.w / 2;
      const baseY = y + player.h;

      ctx.save();
      ctx.translate(cx, baseY);
      ctx.scale(stretchX, stretchY);
      ctx.translate(-cx, -baseY);

      // shadow under player on platform
      // (skip — visual clutter; we use glow instead)

      // body — pirate with bandana
      ctx.shadowColor = "#7df9ff";
      ctx.shadowBlur = 16;

      // legs
      ctx.fillStyle = "#1f2a55";
      const legBob = player.onGround ? Math.sin(timeT * 14) * 2 * Math.min(1, Math.abs(player.vx) / 4) : 0;
      ctx.fillRect(x + 4, y + player.h - 10, 6, 10 + (legBob > 0 ? legBob : 0));
      ctx.fillRect(x + player.w - 10, y + player.h - 10, 6, 10 + (legBob < 0 ? -legBob : 0));

      // boots
      ctx.fillStyle = "#0a0a1a";
      ctx.fillRect(x + 3, y + player.h - 3, 8, 3);
      ctx.fillRect(x + player.w - 11, y + player.h - 3, 8, 3);

      // torso — striped pirate shirt
      ctx.fillStyle = "#fff";
      roundRect(ctx, x + 3, y + 12, player.w - 6, 14, 3);
      ctx.fill();
      ctx.fillStyle = "#ff3aa6";
      ctx.fillRect(x + 3, y + 14, player.w - 6, 2);
      ctx.fillRect(x + 3, y + 18, player.w - 6, 2);
      ctx.fillRect(x + 3, y + 22, player.w - 6, 2);

      // belt
      ctx.fillStyle = "#3a1a0a";
      ctx.fillRect(x + 3, y + 24, player.w - 6, 3);
      ctx.fillStyle = "#ffd24a";
      ctx.fillRect(x + player.w / 2 - 2, y + 24, 4, 3);

      // head
      ctx.fillStyle = "#ffd9a8";
      roundRect(ctx, x + 5, y + 2, player.w - 10, 12, 3);
      ctx.fill();

      // bandana (neon!)
      ctx.fillStyle = "#ff3aa6";
      ctx.shadowColor = "#ff3aa6";
      ctx.shadowBlur = 14;
      roundRect(ctx, x + 4, y + 2, player.w - 8, 6, 2);
      ctx.fill();
      // bandana spots
      ctx.fillStyle = "#fff";
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(x + 9, y + 5, 1, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + player.w - 9, y + 5, 1, 0, Math.PI * 2); ctx.fill();
      // bandana tail
      ctx.fillStyle = "#ff3aa6";
      ctx.shadowColor = "#ff3aa6";
      ctx.shadowBlur = 8;
      const tailX = player.facing > 0 ? x + 2 : x + player.w - 2;
      ctx.beginPath();
      ctx.moveTo(tailX, y + 4);
      ctx.lineTo(tailX - player.facing * 5, y + 7 + Math.sin(timeT * 8) * 1.5);
      ctx.lineTo(tailX - player.facing * 3, y + 9);
      ctx.closePath();
      ctx.fill();

      // eye patch
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#0a0a1a";
      ctx.fillRect(x + (player.facing > 0 ? player.w - 11 : 5), y + 9, 4, 3);
      // other eye
      ctx.fillStyle = "#0a0a1a";
      ctx.fillRect(x + (player.facing > 0 ? 8 : player.w - 12), y + 10, 2, 2);

      // glow outline
      ctx.shadowColor = "#7df9ff";
      ctx.shadowBlur = 18;
      ctx.strokeStyle = "rgba(125,249,255,0.6)";
      ctx.lineWidth = 1.2;
      roundRect(ctx, x + 1, y + 1, player.w - 2, player.h - 2, 4);
      ctx.stroke();

      ctx.restore();

      if (player.hurtT > 0) {
        ctx.fillStyle = `rgba(255,0,80,${player.hurtT})`;
        ctx.fillRect(x, y, player.w, player.h);
      }
    };

    const drawParticles = () => {
      ctx.save();
      for (const p of particles) {
        const t = 1 - p.life / p.maxLife;
        ctx.globalAlpha = t;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 12;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - camX, p.y, p.size, p.size);
      }
      ctx.restore();
    };

    const drawHUD = () => {
      ctx.save();
      ctx.font = "bold 24px ui-sans-serif, system-ui, sans-serif";
      ctx.shadowColor = "#7df9ff";
      ctx.shadowBlur = 12;
      ctx.fillStyle = "#fff";
      ctx.fillText(`SCORE  ${Math.floor(score)}`, 20, 36);

      ctx.font = "bold 14px ui-sans-serif, system-ui, sans-serif";
      ctx.shadowColor = "#ff3aa6";
      ctx.fillStyle = "#ffaee0";
      ctx.fillText(`BEST  ${Math.max(bestScore, Math.floor(score))}`, 20, 56);

      // combo indicator
      if (stompCombo > 1 && stompComboT > 0) {
        ctx.font = `bold ${22 + stompCombo * 2}px ui-sans-serif`;
        ctx.shadowColor = "#ffe57a";
        ctx.fillStyle = "#fff";
        const pulse = 1 + Math.sin(timeT * 14) * 0.05;
        ctx.save();
        ctx.translate(VIEW_W / 2, 80);
        ctx.scale(pulse, pulse);
        ctx.textAlign = "center";
        ctx.fillText(`x${stompCombo} STOMP!`, 0, 0);
        ctx.restore();
        ctx.textAlign = "start";
      }
      ctx.restore();
    };

    const drawTitle = () => {
      ctx.save();
      // dim
      ctx.fillStyle = "rgba(7,6,26,0.5)";
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);

      ctx.textAlign = "center";
      ctx.shadowColor = "#ff3aa6";
      ctx.shadowBlur = 30;
      ctx.fillStyle = "#fff";
      ctx.font = "bold 76px ui-sans-serif, system-ui, sans-serif";
      const wob = Math.sin(titleT * 2) * 4;
      ctx.fillText("NEON COVE", VIEW_W / 2, 200 + wob);

      ctx.shadowColor = "#7df9ff";
      ctx.shadowBlur = 14;
      ctx.font = "bold 22px ui-sans-serif";
      ctx.fillStyle = "#9ff7ff";
      ctx.fillText("a synthwave pirate platformer", VIEW_W / 2, 240 + wob);

      ctx.shadowBlur = 8;
      ctx.font = "bold 18px ui-sans-serif";
      ctx.fillStyle = "#fff";
      const blink = Math.floor(titleT * 2) % 2 === 0;
      if (blink) ctx.fillText("PRESS  SPACE  TO  SET  SAIL", VIEW_W / 2, 320);

      ctx.shadowBlur = 0;
      ctx.font = "14px ui-sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillText("←/→ or A/D  to move      SPACE/W/↑  to jump (up to 3 in the air)", VIEW_W / 2, 380);
      ctx.fillText("STOMP enemies from above • Collect treasure • Don't fall in", VIEW_W / 2, 402);
      if (bestScore > 0) {
        ctx.fillStyle = "#ffaee0";
        ctx.fillText(`Best score: ${bestScore}`, VIEW_W / 2, 432);
      }
      ctx.restore();
    };

    const drawDeath = () => {
      ctx.save();
      const a = Math.min(0.7, deathT * 1.4);
      ctx.fillStyle = `rgba(7,6,26,${a})`;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);

      if (deathT > 0.4) {
        ctx.textAlign = "center";
        ctx.shadowColor = "#ff3aa6";
        ctx.shadowBlur = 30;
        ctx.fillStyle = "#fff";
        ctx.font = "bold 64px ui-sans-serif";
        ctx.fillText("DAVY JONES GOT YA", VIEW_W / 2, 220);

        ctx.shadowColor = "#7df9ff";
        ctx.shadowBlur = 12;
        ctx.font = "bold 28px ui-sans-serif";
        ctx.fillStyle = "#9ff7ff";
        ctx.fillText(`SCORE  ${Math.floor(score)}`, VIEW_W / 2, 270);
        if (Math.floor(score) >= bestScore && Math.floor(score) > 0) {
          ctx.fillStyle = "#ffe57a";
          ctx.shadowColor = "#ffe57a";
          ctx.fillText("✦ NEW BEST ✦", VIEW_W / 2, 300);
        } else {
          ctx.fillText(`BEST  ${bestScore}`, VIEW_W / 2, 300);
        }

        if (deathT > 0.8) {
          const blink = Math.floor(deathT * 2) % 2 === 0;
          ctx.font = "bold 18px ui-sans-serif";
          ctx.fillStyle = "#fff";
          if (blink) ctx.fillText("PRESS  SPACE  TO  RESTART", VIEW_W / 2, 360);
        }
      }
      ctx.restore();
    };

    const draw = () => {
      // shake
      ctx.save();
      if (shakeT > 0) {
        ctx.translate((Math.random() - 0.5) * shakeT, (Math.random() - 0.5) * shakeT);
      }

      drawBackground();

      // platforms
      for (const p of platforms) {
        if (p.x + p.w < camX - 50 || p.x > camX + VIEW_W + 50) continue;
        drawPlatform(p);
      }

      // coins
      for (const c of coins) drawCoin(c);

      // enemies
      for (const e of enemies) drawEnemy(e);

      // player
      if (state === "playing" || state === "dead") drawPlayer();

      drawParticles();

      drawHUD();

      ctx.restore();

      if (state === "title") drawTitle();
      else if (state === "dead") drawDeath();
    };

    // ----- Loop -----
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      update(dt);
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // initial seed: empty world for title screen
    resetGame();
    state = "title";

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerUp);
    };
  }, []);

  return (
    <div
      ref={wrapperRef}
      className="relative w-full h-full flex items-center justify-center select-none"
      style={{
        background:
          "radial-gradient(ellipse at center, #1a0a44 0%, #07061a 70%)",
      }}
    >
      <canvas
        ref={canvasRef}
        className="rounded-xl shadow-[0_0_60px_rgba(255,80,200,0.35)]"
        style={{
          width: "min(100vw, calc(100vh * 16 / 9))",
          height: "min(100vh, calc(100vw * 9 / 16))",
          maxWidth: "100vw",
          maxHeight: "100vh",
          imageRendering: "auto",
          touchAction: "none",
          background: "#07061a",
        }}
      />
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}
