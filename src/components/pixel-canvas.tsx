"use client";

import { useRef, useEffect, useCallback } from "react";
import { clientLogger } from "@/lib/logger-client";

// ────────────────────────── Types ──────────────────────────

export type SlotState = "empty" | "idle" | "typing" | "celebrate" | "looking";

export interface SlotData {
  state: SlotState;
  sessionName?: string;
}

export type EffectType = "bulb" | "document" | "stars" | "flash";

export interface PixelCanvasEffect {
  type: EffectType;
  slotIndex?: number;
}

export interface PixelCanvasProps {
  slots: SlotData[];
  projectName: string;
  agentCount: number;
  collapsed?: boolean;
  effects?: PixelCanvasEffect[];
  onEffectsConsumed?: () => void;
}

// ────────────────────────── Constants ──────────────────────────

const NUM_SLOTS = 7;
const SCALE = 3;
const CANVAS_W = 256;
const CANVAS_H = 256;
const TICK_MS = 10;
const CELEBRATE_MS = 3000;
const LOOKING_MS = 1500;

// Character center positions (derived from bounding-box analysis of each sprite).
// Used for session-name labels and effect anchoring.
const CHAR_POSITIONS: { cx: number; cy: number; topY: number }[] = [
  { cx: 54, cy: 135, topY: 117 },  // slot 0: north-west-staffs-left
  { cx: 96, cy: 114, topY: 96 },   // slot 1: north-west-staffs-right
  { cx: 120, cy: 118, topY: 108 }, // slot 2: middle-staffs-left
  { cx: 155, cy: 115, topY: 105 }, // slot 3: middle-staffs-right
  { cx: 146, cy: 148, topY: 130 }, // slot 4: middle-staffs-bottom
  { cx: 95, cy: 149, topY: 138 },  // slot 5: south-west-staffs-left
  { cx: 133, cy: 168, topY: 158 }, // slot 6: south-west-staffs-right
];

// Y-sort order: draw characters from back (low Y) to front (high Y)
const DRAW_ORDER = Array.from({ length: NUM_SLOTS }, (_, i) => i).sort(
  (a, b) => CHAR_POSITIONS[a].topY - CHAR_POSITIONS[b].topY
);

// ────────────────────────── Internal State Types ──────────────────────────

interface SlotMachine {
  state: SlotState;
  cycleIndex: number;
  frameTicks: number;
  ticksPerFrame: number;
  stateTimer: number;
}

interface ActiveEffect {
  type: EffectType;
  slotIndex: number;
  elapsed: number;
  duration: number;
}

const EFFECT_DURATIONS: Record<EffectType, number> = {
  bulb: 2000,
  document: 1500,
  stars: 2500,
  flash: 400,
};

// ────────────────────────── Image Loading ──────────────────────────

const SPRITE_BASE = "/sprites/";

function buildImageSources(): Record<string, string> {
  const sources: Record<string, string> = { floor: "floor.png" };
  for (let i = 0; i < NUM_SLOTS; i++) {
    sources[`char${i}-frame1`] = `char${i}-frame1.png`;
    sources[`char${i}-frame2`] = `char${i}-frame2.png`;
  }
  return sources;
}

const IMAGE_SOURCES = buildImageSources();

function loadImages(): Promise<Record<string, HTMLImageElement>> {
  return new Promise((resolve) => {
    const images: Record<string, HTMLImageElement> = {};
    const entries = Object.entries(IMAGE_SOURCES);
    let loaded = 0;
    const total = entries.length;

    entries.forEach(([name, file]) => {
      const img = new Image();
      img.onload = () => {
        loaded++;
        if (loaded === total) resolve(images);
      };
      img.onerror = () => {
        clientLogger.warn("Failed to load sprite:", name, file);
        loaded++;
        if (loaded === total) resolve(images);
      };
      img.src = `${SPRITE_BASE}${file}`;
      images[name] = img;
    });
  });
}

// ────────────────────────── Component ──────────────────────────

export function PixelCanvas({
  slots,
  projectName,
  agentCount,
  collapsed = false,
  effects,
  onEffectsConsumed,
}: PixelCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef<Record<string, HTMLImageElement>>({});
  const imagesLoadedRef = useRef(false);
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef(0);
  const tickAccumRef = useRef(0);

  // Slot state machines
  const slotsRef = useRef<SlotMachine[]>(
    Array.from({ length: NUM_SLOTS }, () => ({
      state: "empty" as SlotState,
      cycleIndex: 0,
      frameTicks: 0,
      ticksPerFrame: 1,
      stateTimer: 0,
    }))
  );

  // Props refs for access in game loop
  const slotsDataRef = useRef(slots);
  const projectNameRef = useRef(projectName);
  const agentCountRef = useRef(agentCount);
  const collapsedRef = useRef(collapsed);

  // Effects
  const activeEffectsRef = useRef<ActiveEffect[]>([]);

  // Sync props to refs
  useEffect(() => {
    slotsDataRef.current = slots;
    for (let i = 0; i < NUM_SLOTS; i++) {
      const externalState = slots[i]?.state ?? "empty";
      const machine = slotsRef.current[i];
      if (machine.state !== externalState) {
        machine.state = externalState;
        machine.cycleIndex = 0;
        machine.frameTicks = 0;
        machine.stateTimer = 0;
      }
    }
  }, [slots]);

  useEffect(() => {
    projectNameRef.current = projectName;
  }, [projectName]);

  useEffect(() => {
    agentCountRef.current = agentCount;
  }, [agentCount]);

  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  // Consume incoming effects
  useEffect(() => {
    if (!effects || effects.length === 0) return;
    effects.forEach((eff) => {
      activeEffectsRef.current.push({
        type: eff.type,
        slotIndex: eff.slotIndex ?? 0,
        elapsed: 0,
        duration: EFFECT_DURATIONS[eff.type],
      });
    });
    onEffectsConsumed?.();
  }, [effects, onEffectsConsumed]);

  // ── Render functions ──

  const renderTopBar = useCallback((ctx: CanvasRenderingContext2D) => {
    const H = 16;
    ctx.fillStyle = "#d0d0e0";
    ctx.fillRect(0, 0, CANVAS_W, H);
    ctx.fillStyle = "#e4e4f0";
    ctx.fillRect(0, 0, CANVAS_W, 1);
    ctx.fillStyle = "#9999aa";
    ctx.fillRect(0, H - 1, CANVAS_W, 1);

    ctx.font = "bold 7px monospace";
    ctx.textBaseline = "middle";

    ctx.fillStyle = "#333";
    ctx.textAlign = "left";
    const name = projectNameRef.current;
    const displayName =
      name.length > 20 ? name.slice(0, 18) + ".." : name;
    ctx.fillText(displayName, 6, H / 2);

    ctx.textAlign = "right";
    ctx.fillStyle = "#336";
    const count = agentCountRef.current;
    ctx.fillText(`${count} agent${count !== 1 ? "s" : ""}`, 250, H / 2);

    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }, []);

  const renderSessionLabel = useCallback(
    (ctx: CanvasRenderingContext2D, slotIndex: number) => {
      const sd = slotsDataRef.current[slotIndex];
      if (!sd?.sessionName) return;
      const pos = CHAR_POSITIONS[slotIndex];
      ctx.font = "5px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const text =
        sd.sessionName.length > 12
          ? sd.sessionName.slice(0, 10) + ".."
          : sd.sessionName;
      const tw = ctx.measureText(text).width;
      const px = pos.cx;
      const py = pos.topY - 4;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(px - tw / 2 - 2, py - 6, tw + 4, 7);
      ctx.fillStyle = "#fff";
      ctx.fillText(text, px, py);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    },
    []
  );

  const renderEffects = useCallback((ctx: CanvasRenderingContext2D) => {
    const effs = activeEffectsRef.current;
    for (const eff of effs) {
      const progress = eff.elapsed / eff.duration;
      const pos = CHAR_POSITIONS[eff.slotIndex] || CHAR_POSITIONS[0];

      switch (eff.type) {
        case "bulb": {
          const alpha =
            progress < 0.1
              ? progress / 0.1
              : progress > 0.8
                ? (1 - progress) / 0.2
                : 1;
          const bx = pos.cx;
          const by = pos.topY - 14 - Math.sin(progress * Math.PI * 4) * 2;
          ctx.fillStyle = `rgba(255, 220, 50, ${alpha * 0.3})`;
          ctx.beginPath();
          ctx.arc(bx, by, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgba(255, 230, 80, ${alpha})`;
          ctx.beginPath();
          ctx.arc(bx, by, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgba(255, 255, 200, ${alpha})`;
          ctx.fillRect(bx - 1, by - 1, 2, 2);
          ctx.fillStyle = `rgba(180, 180, 180, ${alpha})`;
          ctx.fillRect(bx - 2, by + 3, 4, 2);
          break;
        }
        case "document": {
          const startX = CANVAS_W;
          const endX = pos.cx;
          const curX = startX + (endX - startX) * Math.min(progress * 2, 1);
          const curY = pos.topY - 10 + Math.sin(progress * Math.PI) * -15;
          const alpha = progress > 0.8 ? (1 - progress) / 0.2 : 1;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = "#f8f8f0";
          ctx.fillRect(curX, curY, 8, 10);
          ctx.strokeStyle = "#aaa";
          ctx.lineWidth = 0.5;
          ctx.strokeRect(curX, curY, 8, 10);
          ctx.fillStyle = "#ccc";
          ctx.fillRect(curX + 1.5, curY + 2, 5, 1);
          ctx.fillRect(curX + 1.5, curY + 4, 4, 1);
          ctx.fillRect(curX + 1.5, curY + 6, 5, 1);
          ctx.globalAlpha = 1;
          break;
        }
        case "stars": {
          const alpha = progress > 0.7 ? (1 - progress) / 0.3 : 1;
          const cx = pos.cx;
          const cy = pos.cy;
          for (let i = 0; i < 8; i++) {
            const angle =
              (i / 8) * Math.PI * 2 + progress * Math.PI * 3;
            const radius = 10 + progress * 15;
            const sx = cx + Math.cos(angle) * radius;
            const sy = cy + Math.sin(angle) * radius;
            const colors = ["#FFD700", "#FF6B6B", "#4ECDC4", "#A78BFA"];
            ctx.fillStyle = colors[i % colors.length];
            ctx.globalAlpha =
              alpha *
              (0.5 + Math.sin(progress * Math.PI * 6 + i) * 0.5);
            const size =
              1.5 + Math.sin(progress * Math.PI * 4 + i) * 0.5;
            ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
          }
          ctx.globalAlpha = 1;
          break;
        }
        case "flash": {
          const alpha =
            progress < 0.3 ? progress / 0.3 : (1 - progress) / 0.7;
          ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.6})`;
          ctx.fillRect(0, 16, CANVAS_W, CANVAS_H - 16);
          break;
        }
      }
    }
  }, []);

  const render = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      images: Record<string, HTMLImageElement>
    ) => {
      ctx.clearRect(0, 0, CANVAS_W * SCALE, CANVAS_H * SCALE);
      ctx.save();
      ctx.scale(SCALE, SCALE);

      // Floor background (256x256)
      const floorImg = images.floor;
      if (floorImg?.complete && floorImg.naturalWidth) {
        ctx.drawImage(floorImg, 0, 0, CANVAS_W, CANVAS_H);
      }

      // Draw characters in Y-sorted order (back to front)
      for (const si of DRAW_ORDER) {
        const machine = slotsRef.current[si];
        if (machine.state === "empty") continue;

        // Pick frame: typing alternates frame1/frame2, others use frame1
        const isTypingFrame2 =
          machine.state === "typing" && machine.cycleIndex % 2 === 1;
        const frameKey = `char${si}-frame${isTypingFrame2 ? 2 : 1}`;
        const charImg = images[frameKey];

        if (charImg?.complete && charImg.naturalWidth) {
          // Celebrate: golden tint via alpha pulsing
          if (machine.state === "celebrate") {
            ctx.save();
            ctx.globalAlpha = 0.85 + Math.sin(Date.now() / 200) * 0.15;
          }

          // Looking: slight vertical bob
          const lookOffset =
            machine.state === "looking"
              ? Math.sin(Date.now() / 300) * 1
              : 0;

          // Character sprites are 256x256 with transparency, pre-positioned
          if (lookOffset !== 0) {
            ctx.save();
            ctx.translate(0, lookOffset);
          }
          ctx.drawImage(charImg, 0, 0, CANVAS_W, CANVAS_H);
          if (lookOffset !== 0) {
            ctx.restore();
          }

          if (machine.state === "celebrate") {
            ctx.restore();
          }
        }

        // Session name label above character
        renderSessionLabel(ctx, si);
      }

      // Top bar overlay
      renderTopBar(ctx);

      // Effects overlay
      renderEffects(ctx);

      ctx.restore();
    },
    [renderTopBar, renderSessionLabel, renderEffects]
  );

  // ── Game Loop ──

  const tick = useCallback((deltaMs: number) => {
    for (let i = 0; i < NUM_SLOTS; i++) {
      const machine = slotsRef.current[i];
      if (machine.state === "empty") continue;

      machine.stateTimer += deltaMs;

      // Auto-transitions
      if (
        machine.state === "celebrate" &&
        machine.stateTimer >= CELEBRATE_MS
      ) {
        machine.state = "idle";
        machine.cycleIndex = 0;
        machine.frameTicks = 0;
        machine.stateTimer = 0;
      }
      if (
        machine.state === "looking" &&
        machine.stateTimer >= LOOKING_MS
      ) {
        machine.state = "idle";
        machine.cycleIndex = 0;
        machine.frameTicks = 0;
        machine.stateTimer = 0;
      }

      // Frame cycling for typing (toggle between frame1/frame2)
      if (machine.state === "typing") {
        machine.frameTicks++;
        if (machine.frameTicks >= machine.ticksPerFrame) {
          machine.frameTicks = 0;
          machine.cycleIndex = (machine.cycleIndex + 1) % 2;
        }
      }
    }

    // Update effects
    const effs = activeEffectsRef.current;
    for (let i = effs.length - 1; i >= 0; i--) {
      effs[i].elapsed += deltaMs;
      if (effs[i].elapsed >= effs[i].duration) {
        effs.splice(i, 1);
      }
    }
  }, []);

  const gameLoop = useCallback(
    (now: number) => {
      if (collapsedRef.current) {
        animFrameRef.current = requestAnimationFrame(gameLoop);
        lastTimeRef.current = now;
        return;
      }

      const delta = now - lastTimeRef.current;
      lastTimeRef.current = now;
      tickAccumRef.current += delta;

      let ticked = false;
      while (tickAccumRef.current >= TICK_MS) {
        tickAccumRef.current -= TICK_MS;
        tick(TICK_MS);
        ticked = true;
      }

      if (ticked) {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (ctx && imagesLoadedRef.current) {
          render(ctx, imagesRef.current);
        }
      }

      animFrameRef.current = requestAnimationFrame(gameLoop);
    },
    [tick, render]
  );

  // ── Init ──

  useEffect(() => {
    let cancelled = false;

    loadImages().then((images) => {
      if (cancelled) return;
      imagesRef.current = images;
      imagesLoadedRef.current = true;

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingEnabled = false;
        render(ctx, images);
      }

      lastTimeRef.current = performance.now();
      animFrameRef.current = requestAnimationFrame(gameLoop);
    });

    return () => {
      cancelled = true;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [render, gameLoop]);

  return (
    <canvas
      ref={canvasRef}
      width={CANVAS_W * SCALE}
      height={CANVAS_H * SCALE}
      className="w-full"
      style={{
        imageRendering: "pixelated",
        aspectRatio: "1 / 1",
      }}
    />
  );
}
