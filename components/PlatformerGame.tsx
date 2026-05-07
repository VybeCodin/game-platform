"use client";

import type { FormEvent } from "react";
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
type Ship = {
  x: number;
  y: number;
  w: number;
  h: number;
  mastH: number;
  bobPhase: number;
  reload: number;
  flashT: number;
};
type Cannonball = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  live: boolean;
  trailT: number;
};
type LeaderboardEntry = {
  id: string;
  name: string;
  score: number;
  date: string;
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
const CANNONBALL_GRAVITY = 0.28;
const BEST_SCORE_KEY = "neon-cove-best";
const LEADERBOARD_KEY = "neon-cove-leaderboard";
const LEADERBOARD_LIMIT = 8;

function sortLeaderboard(entries: LeaderboardEntry[]) {
  return [...entries]
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date) || a.name.localeCompare(b.name))
    .slice(0, LEADERBOARD_LIMIT);
}

function readLeaderboard() {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(LEADERBOARD_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    const entries = raw
      .map((entry): LeaderboardEntry | null => {
        if (!entry || typeof entry !== "object") return null;
        const name = typeof entry.name === "string" ? entry.name.trim().slice(0, 18) : "";
        const score = typeof entry.score === "number" ? Math.floor(entry.score) : Number(entry.score);
        const date = typeof entry.date === "string" ? entry.date : new Date(0).toISOString();
        if (!name || !Number.isFinite(score) || score <= 0) return null;
        return {
          id: typeof entry.id === "string" && entry.id ? entry.id : `${date}-${name}`,
          name,
          score,
          date,
        };
      })
      .filter((entry): entry is LeaderboardEntry => entry !== null);
    return sortLeaderboard(entries);
  } catch {
    return [];
  }
}

function qualifiesForLeaderboard(score: number, entries: LeaderboardEntry[]) {
  if (score <= 0) return false;
  if (entries.length < LEADERBOARD_LIMIT) return true;
  return score >= entries[entries.length - 1].score;
}

function sanitizePlayerName(name: string) {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 18);
  return clean || "Deckhand";
}

export default function PlatformerGame() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const leaderboardRef = useRef<LeaderboardEntry[]>([]);
  const bestScoreRef = useRef(0);
  const pendingScoreRef = useRef<number | null>(null);
  const needsNameEntryRef = useRef(false);
  const [hud, setHud] = useState({ score: 0, best: 0, state: "title" as "title" | "playing" | "dead" });
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [pendingScore, setPendingScore] = useState<number | null>(null);
  const [needsNameEntry, setNeedsNameEntry] = useState(false);
  const [playerName, setPlayerName] = useState("");

  const closeNameEntry = () => {
    pendingScoreRef.current = null;
    needsNameEntryRef.current = false;
    setPendingScore(null);
    setNeedsNameEntry(false);
    setPlayerName("");
  };

  const openNameEntry = (score: number) => {
    pendingScoreRef.current = score;
    needsNameEntryRef.current = true;
    setPendingScore(score);
    setNeedsNameEntry(true);
    setPlayerName("");
  };

  const submitLeaderboardEntry = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const score = pendingScoreRef.current;
    if (score === null) return;

    const entry: LeaderboardEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: sanitizePlayerName(playerName),
      score,
      date: new Date().toISOString(),
    };
    const nextBoard = sortLeaderboard([...leaderboardRef.current, entry]);
    const nextBest = Math.max(bestScoreRef.current, nextBoard[0]?.score ?? 0);

    leaderboardRef.current = nextBoard;
    bestScoreRef.current = nextBest;
    window.localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(nextBoard));
    window.localStorage.setItem(BEST_SCORE_KEY, String(nextBest));

    setLeaderboard(nextBoard);
    setHud((current) => ({ ...current, best: nextBest }));
    closeNameEntry();
  };

  useEffect(() => {
    if (needsNameEntry) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [needsNameEntry]);

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
      cannon: () => { playTone(110, 0.16, "sawtooth", 0.06, 70); setTimeout(() => playTone(72, 0.24, "square", 0.04, 48), 40); },
      death: () => { playTone(440, 0.18, "sawtooth", 0.07, 110); setTimeout(() => playTone(220, 0.3, "sawtooth", 0.07, 60), 120); },
      start: () => { playTone(523, 0.08, "triangle", 0.05); setTimeout(() => playTone(659, 0.08, "triangle", 0.05), 80); setTimeout(() => playTone(880, 0.14, "triangle", 0.06), 160); },
    };

    // ----- Game state -----
    type State = "title" | "playing" | "dead";
    let state: State = "title";
    const savedLeaderboard = readLeaderboard();
    leaderboardRef.current = savedLeaderboard;
    setLeaderboard(savedLeaderboard);
    let bestScore = Math.max(
      Number(window.localStorage.getItem(BEST_SCORE_KEY) || "0"),
      savedLeaderboard[0]?.score ?? 0,
    );
    bestScoreRef.current = bestScore;
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
    let ships: Ship[] = [];
    let cannonballs: Cannonball[] = [];
    let particles: Particle[] = [];
    let nextShipX = 620;

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

    const spawnShip = (x: number) => {
      ships.push({
        x,
        y: GROUND_Y + rand(10, 22),
        w: rand(76, 112),
        h: rand(20, 28),
        mastH: rand(28, 42),
        bobPhase: Math.random() * Math.PI * 2,
        reload: rand(1.2, 2.4),
        flashT: 0,
      });
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

      while (nextShipX < targetX - 80) {
        spawnShip(nextShipX + rand(-40, 55));
        nextShipX += rand(360, 560);
      }
    };

    const resetGame = () => {
      platforms = [];
      enemies = [];
      coins = [];
      ships = [];
      cannonballs = [];
      particles = [];
      nextShipX = 620;
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
      closeNameEntry();
    };

    // ----- Input -----
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
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

    const isStompHit = (enemy: Enemy, prevBottom: number) => {
      const playerBottom = player.y + player.h;
      const overlapX = Math.min(player.x + player.w, enemy.x + enemy.w) - Math.max(player.x, enemy.x);
      const overlapY = Math.min(playerBottom, enemy.y + enemy.h) - Math.max(player.y, enemy.y);
      const cameFromAbove = prevBottom <= enemy.y + 8;
      const landedOnTop = playerBottom <= enemy.y + enemy.h * 0.45;
      const verticalHitDominates = overlapY <= overlapX + 2;
      return player.vy > 0 && overlapX > 0 && overlapY > 0 && cameFromAbove && landedOnTop && verticalHitDominates;
    };

    const circleHitsRect = (cx: number, cy: number, r: number, rect: Rect) => {
      const nearestX = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
      const nearestY = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
      const dx = cx - nearestX;
      const dy = cy - nearestY;
      return dx * dx + dy * dy <= r * r;
    };

    const fireShip = (ship: Ship) => {
      const dx = player.x + player.w * 0.5 + player.vx * 16 - ship.x;
      const frames = Math.max(34, Math.min(68, Math.abs(dx) / 4.2));
      const muzzleX = ship.x + Math.sign(dx || 1) * ship.w * 0.28;
      const muzzleY = ship.y - ship.h - 8;
      const targetY = player.y + player.h * 0.45;
      const vx = dx / frames;
      const vy = (targetY - muzzleY - CANNONBALL_GRAVITY * frames * (frames + 1) * 0.5) / frames;

      cannonballs.push({
        x: muzzleX,
        y: muzzleY,
        vx,
        vy,
        r: rand(6, 8.5),
        live: true,
        trailT: 0,
      });
      ship.reload = rand(2.4, 4.2);
      ship.flashT = 0.18;
      sfx.cannon();
      burst(muzzleX, muzzleY, "#f6d6a4", 8, 2.2);
    };

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
      const finalScore = Math.floor(score);
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestScoreRef.current = finalScore;
        window.localStorage.setItem(BEST_SCORE_KEY, String(bestScore));
      }
      if (qualifiesForLeaderboard(finalScore, leaderboardRef.current)) {
        openNameEntry(finalScore);
      } else {
        closeNameEntry();
      }
      setHud({ score: finalScore, best: bestScore, state: "dead" });
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
        if (!needsNameEntryRef.current && (restartPressed || keys.has("enter")) && deathT > 0.6) {
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

      const prevPlayerBottom = player.y + player.h;

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
          if (isStompHit(e, prevPlayerBottom)) {
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

      // Ships + cannonballs
      for (const ship of ships) {
        ship.flashT = Math.max(0, ship.flashT - dt);
        ship.reload -= dt;
        const shipInRange = ship.x > camX - 140 && ship.x < camX + VIEW_W + 140;
        const playerAhead = player.x > 260 && Math.abs(player.x - ship.x) < 520;
        if (shipInRange && playerAhead && ship.reload <= 0) {
          fireShip(ship);
        }
      }

      for (const ball of cannonballs) {
        if (!ball.live) continue;
        const prevY = ball.y;
        ball.x += ball.vx;
        ball.y += ball.vy;
        ball.vy += CANNONBALL_GRAVITY;
        ball.trailT += dt;

        if (ball.trailT > 0.04) {
          ball.trailT = 0;
          particles.push({
            x: ball.x,
            y: ball.y,
            vx: rand(-0.4, 0.4),
            vy: rand(-0.5, -0.1),
            life: 0,
            maxLife: rand(10, 18),
            color: "rgba(255,244,227,0.55)",
            size: rand(1.5, 2.5),
          });
        }

        if (circleHitsRect(ball.x, ball.y, ball.r + 1, player)) {
          burst(ball.x, ball.y, "#f3d7a6", 18, 3.4);
          shakeT = 10;
          die();
          return;
        }

        let hitPlatform = false;
        for (const p of platforms) {
          if (circleHitsRect(ball.x, ball.y, ball.r, p) && prevY + ball.r <= p.y + 6) {
            hitPlatform = true;
            break;
          }
        }

        if (hitPlatform) {
          ball.live = false;
          burst(ball.x, ball.y, "#e8c999", 12, 2.6);
          continue;
        }

        if (ball.y + ball.r >= GROUND_Y + 4) {
          ball.live = false;
          burst(ball.x, GROUND_Y + 4, "#9bd0d2", 12, 2.4);
        }
      }
      cannonballs = cannonballs.filter(
        (ball) =>
          ball.live &&
          ball.x > camX - 260 &&
          ball.x < camX + VIEW_W + 260 &&
          ball.y < VIEW_H + 120,
      );
      ships = ships.filter((ship) => ship.x + ship.w > camX - 280);

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
      const horizon = GROUND_Y - 6;

      const sky = ctx.createLinearGradient(0, 0, 0, VIEW_H);
      sky.addColorStop(0, "#0d2131");
      sky.addColorStop(0.45, "#29495f");
      sky.addColorStop(0.72, "#a16b3a");
      sky.addColorStop(1, "#d4a06b");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);

      const moonX = VIEW_W * 0.74;
      const moonY = 130;
      const moonR = 58;
      const moonGlow = ctx.createRadialGradient(moonX, moonY, 8, moonX, moonY, moonR * 2.1);
      moonGlow.addColorStop(0, "rgba(255,244,212,0.95)");
      moonGlow.addColorStop(0.28, "rgba(255,225,165,0.72)");
      moonGlow.addColorStop(1, "rgba(255,225,165,0)");
      ctx.fillStyle = moonGlow;
      ctx.beginPath();
      ctx.arc(moonX, moonY, moonR * 2.1, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#fff1cf";
      ctx.beginPath();
      ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      for (let i = 0; i < 36; i++) {
        const sx = ((i * 157.5 - camX * 0.03) % VIEW_W + VIEW_W) % VIEW_W;
        const sy = 24 + (i * 41) % 170;
        const tw = 0.45 + 0.55 * Math.sin(timeT * 1.8 + i);
        ctx.globalAlpha = 0.2 + tw * 0.4;
        ctx.fillStyle = "#fff7dd";
        ctx.fillRect(sx, sy, 1.5, 1.5);
      }
      ctx.restore();

      ctx.save();
      ctx.fillStyle = "rgba(25, 39, 41, 0.96)";
      ctx.beginPath();
      ctx.moveTo(0, horizon + 6);
      ctx.lineTo(90, horizon - 10);
      ctx.lineTo(160, horizon + 2);
      ctx.lineTo(245, horizon - 32);
      ctx.lineTo(320, horizon + 8);
      ctx.lineTo(430, horizon - 14);
      ctx.lineTo(560, horizon + 6);
      ctx.lineTo(660, horizon - 26);
      ctx.lineTo(760, horizon + 4);
      ctx.lineTo(860, horizon - 18);
      ctx.lineTo(VIEW_W, horizon + 10);
      ctx.lineTo(VIEW_W, horizon + 60);
      ctx.lineTo(0, horizon + 60);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      const shipX = ((-camX * 0.1) % (VIEW_W + 200) + VIEW_W + 200) % (VIEW_W + 200) - 100;
      ctx.save();
      ctx.fillStyle = "rgba(38, 21, 9, 0.95)";
      ctx.translate(shipX, horizon - 18 + Math.sin(timeT * 0.7) * 3);
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

      const sea = ctx.createLinearGradient(0, horizon, 0, VIEW_H);
      sea.addColorStop(0, "#214d5b");
      sea.addColorStop(0.45, "#173a46");
      sea.addColorStop(1, "#091c25");
      ctx.fillStyle = sea;
      ctx.fillRect(0, horizon, VIEW_W, VIEW_H - horizon);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(moonX - 38, horizon + 10);
      ctx.lineTo(moonX + 38, horizon + 10);
      ctx.lineTo(moonX + 92, VIEW_H);
      ctx.lineTo(moonX - 92, VIEW_H);
      ctx.closePath();
      const reflection = ctx.createLinearGradient(0, horizon, 0, VIEW_H);
      reflection.addColorStop(0, "rgba(255,230,172,0.24)");
      reflection.addColorStop(1, "rgba(255,230,172,0)");
      ctx.fillStyle = reflection;
      ctx.fill();
      ctx.restore();

      for (let layer = 0; layer < 4; layer++) {
        const layerTop = horizon + 22 + layer * 28;
        const amp = 5 + layer * 2.6;
        const speed = 0.8 + layer * 0.22;
        const freq = 0.022 - layer * 0.002;
        ctx.beginPath();
        ctx.moveTo(0, VIEW_H);
        ctx.lineTo(0, layerTop);
        for (let x = 0; x <= VIEW_W + 20; x += 16) {
          const waveY =
            layerTop +
            Math.sin(x * freq + timeT * speed * 3 + layer * 0.9) * amp +
            Math.sin(x * (freq * 0.55) - timeT * speed * 1.6) * amp * 0.35;
          ctx.lineTo(x, waveY);
        }
        ctx.lineTo(VIEW_W, VIEW_H);
        ctx.closePath();
        ctx.fillStyle = [
          "rgba(39, 93, 106, 0.28)",
          "rgba(28, 78, 90, 0.34)",
          "rgba(20, 60, 70, 0.44)",
          "rgba(12, 38, 47, 0.7)",
        ][layer];
        ctx.fill();
      }

      ctx.save();
      ctx.strokeStyle = "rgba(241, 228, 191, 0.36)";
      ctx.lineWidth = 1.2;
      for (let band = 0; band < 5; band++) {
        const lineY = horizon + 16 + band * 20;
        ctx.beginPath();
        for (let x = 0; x <= VIEW_W + 12; x += 12) {
          const y =
            lineY +
            Math.sin(x * 0.026 + timeT * (2.2 + band * 0.15) + band) * (2.5 + band * 0.45) +
            Math.cos(x * 0.011 - timeT * 1.1) * 1.4;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    };

    const drawPlatform = (p: Platform) => {
      const x = p.x - camX;
      const bob = Math.sin(timeT * 1.2 + p.phase) * 3;
      const y = p.y + bob;
      const woodHue = 24 + ((p.hue % 80) / 80) * 12;

      ctx.save();
      ctx.shadowColor = "rgba(20, 10, 2, 0.35)";
      ctx.shadowBlur = 14;
      const grd = ctx.createLinearGradient(x, y, x, y + p.h);
      grd.addColorStop(0, `hsl(${woodHue}, 48%, 41%)`);
      grd.addColorStop(1, `hsl(${woodHue - 2}, 44%, 21%)`);
      ctx.fillStyle = grd;
      roundRect(ctx, x, y, p.w, p.h, 4);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(242, 210, 158, 0.8)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 3, y + 1);
      ctx.lineTo(x + p.w - 3, y + 1);
      ctx.stroke();

      // plank lines
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(56, 31, 13, 0.66)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const lx = x + (p.w * i) / 4;
        ctx.beginPath();
        ctx.moveTo(lx, y + 3);
        ctx.lineTo(lx, y + p.h - 3);
        ctx.stroke();
      }

      ctx.strokeStyle = "rgba(214, 182, 129, 0.9)";
      ctx.lineWidth = 1.4;
      for (const offset of [12, p.w - 12]) {
        ctx.beginPath();
        ctx.moveTo(x + offset, y + 2);
        ctx.lineTo(x + offset, y + p.h - 2);
        ctx.stroke();
      }

      ctx.fillStyle = "#d7b16d";
      ctx.shadowColor = "rgba(215, 177, 109, 0.4)";
      ctx.shadowBlur = 4;
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

    const drawShip = (ship: Ship) => {
      const x = ship.x - camX;
      const bob = Math.sin(timeT * 1.7 + ship.bobPhase) * 4;
      const y = ship.y + bob;
      const hullTop = y - ship.h;

      ctx.save();

      ctx.fillStyle = "rgba(11, 32, 40, 0.24)";
      ctx.beginPath();
      ctx.ellipse(x, y + 6, ship.w * 0.62, 9, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#4a2812";
      ctx.beginPath();
      ctx.moveTo(x - ship.w * 0.5, hullTop + ship.h * 0.18);
      ctx.lineTo(x + ship.w * 0.5, hullTop + ship.h * 0.18);
      ctx.lineTo(x + ship.w * 0.34, y);
      ctx.lineTo(x - ship.w * 0.38, y);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = "#6b3f1d";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - ship.w * 0.46, hullTop + ship.h * 0.28);
      ctx.lineTo(x + ship.w * 0.46, hullTop + ship.h * 0.28);
      ctx.stroke();

      ctx.fillStyle = "#6d4521";
      ctx.fillRect(x - 2, hullTop - ship.mastH, 4, ship.mastH + 4);

      ctx.fillStyle = "#efe4c8";
      ctx.beginPath();
      ctx.moveTo(x + 4, hullTop - ship.mastH + 8);
      ctx.lineTo(x + ship.w * 0.26, hullTop - ship.mastH + 24);
      ctx.lineTo(x + 4, hullTop - ship.mastH + 42);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "#5c1f14";
      ctx.beginPath();
      ctx.moveTo(x + 4, hullTop - ship.mastH + 12);
      ctx.lineTo(x + ship.w * 0.12, hullTop - ship.mastH + 18);
      ctx.lineTo(x + 4, hullTop - ship.mastH + 24);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = "rgba(243, 234, 208, 0.35)";
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      for (let i = 0; i <= 20; i++) {
        const px = x - ship.w * 0.56 + i * (ship.w * 1.12 / 20);
        const py = y + 8 + Math.sin(timeT * 3.2 + i * 0.55 + ship.bobPhase) * 2.6;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      if (ship.flashT > 0) {
        ctx.globalAlpha = Math.min(1, ship.flashT * 5);
        ctx.fillStyle = "#ffd38d";
        ctx.beginPath();
        ctx.arc(x + ship.w * 0.32, hullTop + ship.h * 0.45, 8 + ship.flashT * 24, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    };

    const drawCannonball = (ball: Cannonball) => {
      const x = ball.x - camX;
      const y = ball.y;

      ctx.save();
      ctx.fillStyle = "rgba(255, 240, 208, 0.16)";
      ctx.beginPath();
      ctx.arc(x - ball.vx * 1.4, y - ball.vy * 0.4, ball.r * 1.45, 0, Math.PI * 2);
      ctx.fill();

      ctx.shadowColor = "rgba(255, 216, 146, 0.24)";
      ctx.shadowBlur = 8;
      ctx.fillStyle = "#20150d";
      ctx.beginPath();
      ctx.arc(x, y, ball.r, 0, Math.PI * 2);
      ctx.fill();
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
      ctx.font = "bold 24px Georgia, Times New Roman, serif";
      ctx.shadowColor = "rgba(26, 15, 6, 0.55)";
      ctx.shadowBlur = 12;
      ctx.fillStyle = "#f6e7c4";
      ctx.fillText(`TREASURE  ${Math.floor(score)}`, 20, 36);

      ctx.font = "bold 14px Georgia, Times New Roman, serif";
      ctx.shadowColor = "rgba(26, 15, 6, 0.4)";
      ctx.fillStyle = "#d9bf84";
      ctx.fillText(`BEST HAUL  ${Math.max(bestScore, Math.floor(score))}`, 20, 56);

      // combo indicator
      if (stompCombo > 1 && stompComboT > 0) {
        ctx.font = `bold ${22 + stompCombo * 2}px Georgia, Times New Roman, serif`;
        ctx.shadowColor = "rgba(92, 54, 15, 0.5)";
        ctx.fillStyle = "#ffe0a8";
        const pulse = 1 + Math.sin(timeT * 14) * 0.05;
        ctx.save();
        ctx.translate(VIEW_W / 2, 80);
        ctx.scale(pulse, pulse);
        ctx.textAlign = "center";
        ctx.fillText(`x${stompCombo} BROADSIDE!`, 0, 0);
        ctx.restore();
        ctx.textAlign = "start";
      }
      ctx.restore();
    };

    const drawTitle = () => {
      ctx.save();
      ctx.fillStyle = "rgba(17, 17, 11, 0.28)";
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);

      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(71, 42, 16, 0.45)";
      ctx.shadowBlur = 26;
      ctx.fillStyle = "#fff2d0";
      ctx.font = "bold 74px Georgia, Times New Roman, serif";
      const wob = Math.sin(titleT * 2) * 4;
      ctx.fillText("NEON COVE", VIEW_W / 2, 200 + wob);

      ctx.shadowColor = "rgba(71, 42, 16, 0.28)";
      ctx.shadowBlur = 8;
      ctx.font = "bold 22px Georgia, Times New Roman, serif";
      ctx.fillStyle = "#e5c890";
      ctx.fillText("ride the cove, raid the tide, outrun the deep", VIEW_W / 2, 240 + wob);

      ctx.shadowBlur = 6;
      ctx.font = "bold 18px Georgia, Times New Roman, serif";
      ctx.fillStyle = "#f5ead4";
      const blink = Math.floor(titleT * 2) % 2 === 0;
      if (blink) ctx.fillText("PRESS  SPACE  TO  SET  SAIL", VIEW_W / 2, 320);

      ctx.shadowBlur = 0;
      ctx.font = "14px Georgia, Times New Roman, serif";
      ctx.fillStyle = "rgba(255,244,223,0.82)";
      ctx.fillText("←/→ or A/D  to move      SPACE/W/↑  to jump (up to 3 in the air)", VIEW_W / 2, 380);
      ctx.fillText("Stomp enemies • Dodge cannon fire • Collect treasure • Don't fall in", VIEW_W / 2, 402);
      if (bestScore > 0) {
        ctx.fillStyle = "#d7b16d";
        ctx.fillText(`Captain's best haul: ${bestScore}`, VIEW_W / 2, 432);
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
        ctx.shadowColor = "rgba(71, 42, 16, 0.42)";
        ctx.shadowBlur = 24;
        ctx.fillStyle = "#fff1cf";
        ctx.font = "bold 62px Georgia, Times New Roman, serif";
        ctx.fillText("DAVY JONES GOT YA", VIEW_W / 2, 220);

        ctx.shadowColor = "rgba(71, 42, 16, 0.24)";
        ctx.shadowBlur = 10;
        ctx.font = "bold 28px Georgia, Times New Roman, serif";
        ctx.fillStyle = "#e9ce96";
        ctx.fillText(`TREASURE  ${Math.floor(score)}`, VIEW_W / 2, 270);
        if (Math.floor(score) >= bestScore && Math.floor(score) > 0) {
          ctx.fillStyle = "#d7b16d";
          ctx.shadowColor = "rgba(215, 177, 109, 0.28)";
          ctx.fillText("✦ NEW BEST HAUL ✦", VIEW_W / 2, 300);
        } else {
          ctx.fillText(`BEST HAUL  ${bestScore}`, VIEW_W / 2, 300);
        }

        if (deathT > 0.8) {
          const blink = Math.floor(deathT * 2) % 2 === 0;
          ctx.font = "bold 18px Georgia, Times New Roman, serif";
          ctx.fillStyle = "#f7ecda";
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

      for (const ship of ships) {
        if (ship.x + ship.w < camX - 120 || ship.x - ship.w > camX + VIEW_W + 120) continue;
        drawShip(ship);
      }

      // platforms
      for (const p of platforms) {
        if (p.x + p.w < camX - 50 || p.x > camX + VIEW_W + 50) continue;
        drawPlatform(p);
      }

      // coins
      for (const c of coins) drawCoin(c);

      // enemies
      for (const e of enemies) drawEnemy(e);

      // cannonballs
      for (const ball of cannonballs) drawCannonball(ball);

      // player
      if (state === "playing" || state === "dead") drawPlayer();

      drawParticles();

      drawHUD();

      ctx.restore();

      if (state === "title") drawTitle();
      else if (state === "dead") drawDeath();
    };

    // ----- Loop -----
    // Fixed-timestep accumulator so physics run at 60Hz regardless of
    // the display's refresh rate (otherwise 120Hz monitors play 2x speed).
    const FIXED_DT = 1 / 60;
    let last = performance.now();
    let acc = 0;
    let raf = 0;
    const tick = (now: number) => {
      const frameDt = Math.min(0.1, (now - last) / 1000);
      last = now;
      acc += frameDt;
      let steps = 0;
      while (acc >= FIXED_DT && steps < 5) {
        update(FIXED_DT);
        acc -= FIXED_DT;
        steps++;
      }
      // If we somehow fell way behind, drop the surplus to avoid spiral-of-death.
      if (acc > FIXED_DT * 5) acc = 0;
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
          "radial-gradient(circle at top, rgba(214,160,94,0.2), transparent 34%), linear-gradient(180deg, #102635 0%, #143346 42%, #08141d 100%)",
      }}
    >
      <canvas
        ref={canvasRef}
        className="rounded-[24px] border border-[#c49a61]/25 shadow-[0_22px_80px_rgba(10,14,18,0.55)]"
        style={{
          width: "min(100vw, calc(100vh * 16 / 9))",
          height: "min(100vh, calc(100vw * 9 / 16))",
          maxWidth: "100vw",
          maxHeight: "100vh",
          imageRendering: "auto",
          touchAction: "none",
          background: "#0f2431",
        }}
      />
      <aside className="pointer-events-auto absolute inset-x-3 bottom-3 z-10 rounded-[30px] border border-[#6d4a24]/35 bg-[linear-gradient(180deg,rgba(241,226,187,0.95),rgba(213,183,130,0.93))] p-4 text-[#2f1d0e] shadow-[0_24px_60px_rgba(0,0,0,0.35)] md:inset-x-auto md:right-4 md:top-4 md:bottom-auto md:w-[320px]">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <div>
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.35em] text-[#7a4f23]/80">Captain's Ledger</p>
            <h2 className="text-xl font-black tracking-[0.08em] text-[#2c1708]">Neon Cove</h2>
          </div>
          <div className="text-right">
            <p className="text-[0.65rem] uppercase tracking-[0.28em] text-[#7a4f23]/70">Best Haul</p>
            <p className="text-2xl font-black text-[#5b2f0f]">{Math.max(bestScoreRef.current, leaderboard[0]?.score ?? 0)}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-[#7b582d]/20 bg-[rgba(112,74,33,0.08)] px-3 py-2 text-xs uppercase tracking-[0.24em] text-[#6b4319]">
          Local top {LEADERBOARD_LIMIT} scores on this device
        </div>

        <div className="mt-3 space-y-2">
          {leaderboard.length > 0 ? (
            leaderboard.map((entry, index) => (
              <div
                key={entry.id}
                className="grid grid-cols-[40px_1fr_auto] items-center gap-3 rounded-2xl border border-[#7b582d]/15 bg-[rgba(255,247,232,0.46)] px-3 py-2"
              >
                <div className="text-lg font-black text-[#7a4b20]">{String(index + 1).padStart(2, "0")}</div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold uppercase tracking-[0.16em] text-[#2f1d0e]">{entry.name}</p>
                  <p className="text-[0.65rem] uppercase tracking-[0.22em] text-[#7a5d40]">
                    {new Date(entry.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </p>
                </div>
                <div className="text-right text-lg font-black text-[#5b2f0f]">{entry.score}</div>
              </div>
            ))
          ) : (
            <div className="rounded-2xl border border-dashed border-[#7b582d]/25 bg-[rgba(255,247,232,0.34)] px-4 py-5 text-sm text-[#5b4226]">
              No posted runs yet. Finish a round and claim the first spot.
            </div>
          )}
        </div>
      </aside>

      {needsNameEntry && pendingScore !== null ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#08141d]/70 p-4 backdrop-blur-sm">
          <form
            onSubmit={submitLeaderboardEntry}
            className="w-full max-w-sm rounded-[28px] border border-[#6d4a24]/30 bg-[linear-gradient(180deg,rgba(243,229,194,0.98),rgba(216,187,136,0.97))] p-5 text-[#2f1d0e] shadow-[0_25px_90px_rgba(0,0,0,0.45)]"
          >
            <p className="text-[0.68rem] font-semibold uppercase tracking-[0.35em] text-[#7a4f23]/80">New Log Entry</p>
            <h3 className="mt-2 text-3xl font-black tracking-[0.08em] text-[#2c1708]">Treasure {pendingScore}</h3>
            <p className="mt-2 text-sm text-[#5c4327]">This run made the ledger. Add a captain name before you restart.</p>

            <label className="mt-4 block text-[0.68rem] font-semibold uppercase tracking-[0.28em] text-[#7a4f23]/80" htmlFor="leaderboard-name">
              Captain Name
            </label>
            <input
              id="leaderboard-name"
              ref={nameInputRef}
              value={playerName}
              onChange={(event) => setPlayerName(event.target.value)}
              maxLength={18}
              placeholder="Deckhand"
              className="mt-2 w-full rounded-2xl border border-[#7b582d]/25 bg-[rgba(255,248,233,0.74)] px-4 py-3 text-base font-semibold tracking-[0.08em] text-[#2f1d0e] outline-none transition focus:border-[#8d6230] focus:ring-2 focus:ring-[#b98a51]/25"
            />

            <div className="mt-4 flex gap-3">
              <button
                type="submit"
                className="flex-1 rounded-2xl bg-[#6b3f1d] px-4 py-3 text-sm font-black uppercase tracking-[0.2em] text-[#f6e7c4] transition hover:bg-[#7a4b20]"
              >
                Post Score
              </button>
              <button
                type="button"
                onClick={closeNameEntry}
                className="rounded-2xl border border-[#7b582d]/25 px-4 py-3 text-sm font-black uppercase tracking-[0.2em] text-[#5a3818] transition hover:bg-[rgba(112,74,33,0.08)]"
              >
                Skip
              </button>
            </div>
          </form>
        </div>
      ) : null}
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
