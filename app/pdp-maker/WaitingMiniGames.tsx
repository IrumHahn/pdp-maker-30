"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from "react";
import { Crosshair, Shuffle, Sparkles } from "lucide-react";

import styles from "./pdp-maker.module.css";

/**
 * Waiting-screen mini-games.
 *
 * Ten genuinely distinct, requestAnimationFrame-animated casual games that play
 * while the AI generates section images. Each game owns its own entities/physics
 * and reports hits/misses up to the shared HUD (score / combo / miss). A "다른
 * 게임" button reshuffles to a different random game. Browser hooks
 * `render_game_to_text` / `advanceTime` stay compatible for the eval agent.
 */

// Patch palette (matches the existing dark-board mini-game look, NOT the green
// brand vars --teal/--gold which are lime).
const GOLD = "#d8b65b";
const TEAL = "#4cb7aa";
const CORAL = "#c8474d";
const BLUE = "#2f6bff";
const CREAM = "#f4efe6";
const NAVY = "#1d3748";

type Tone = "good" | "bad" | "perfect";

type SnapshotTarget = {
  id: string;
  label: string;
  x: number;
  y: number;
  size: number;
  isCorrect: boolean;
};

type GameApi = {
  hit: (points: number, label?: string) => void;
  miss: () => void;
  flash: (text: string, tone: Tone) => void;
  report: (targets: SnapshotTarget[]) => void;
  setAdvance: (fn: () => void) => void;
};

type GameProps = { api: GameApi; active: boolean };

let uidCounter = 0;
const uid = () => `wg-${(uidCounter = (uidCounter + 1) % 1_000_000_000)}`;
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

function useFrame(): () => void {
  const [, setFrame] = useState(0);
  return useCallback(() => setFrame((value) => (value + 1) % 1_000_000), []);
}

function useRafLoop(step: (dt: number) => void, active: boolean) {
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    let raf = 0;
    let last = 0;
    let running = true;
    const frame = (now: number) => {
      if (!running) {
        return;
      }
      if (last === 0) {
        last = now;
      }
      const dt = Math.min(50, now - last);
      last = now;
      stepRef.current(dt);
      raf = window.requestAnimationFrame(frame);
    };
    raf = window.requestAnimationFrame(frame);
    return () => {
      running = false;
      window.cancelAnimationFrame(raf);
    };
  }, [active]);
}

// --- 1. 빛나는 패치 잡기 (drifting glow patches) ---------------------------------
type Spark = { id: string; x: number; y: number; vx: number; vy: number; size: number; life: number };

function SparkDriftGame({ api, active }: GameProps): ReactElement {
  const sparksRef = useRef<Spark[]>([]);
  const bump = useFrame();
  const spawn = (): Spark => ({
    id: uid(),
    x: rand(16, 84),
    y: rand(24, 78),
    vx: rand(-13, 13),
    vy: rand(-13, 13),
    size: rand(44, 58),
    life: rand(2600, 3600)
  });
  if (sparksRef.current.length === 0) {
    sparksRef.current = [spawn(), spawn(), spawn()];
  }
  const tap = (id: string) => {
    const found = sparksRef.current.find((spark) => spark.id === id);
    if (!found) {
      return;
    }
    api.hit(10);
    sparksRef.current = sparksRef.current.filter((spark) => spark.id !== id);
    sparksRef.current.push(spawn());
  };
  useRafLoop((dt) => {
    const s = dt / 1000;
    const next: Spark[] = [];
    for (const spark of sparksRef.current) {
      let { x, y, vx, vy } = spark;
      x += vx * s;
      y += vy * s;
      if (x < 8) {
        x = 8;
        vx = Math.abs(vx);
      }
      if (x > 92) {
        x = 92;
        vx = -Math.abs(vx);
      }
      if (y < 16) {
        y = 16;
        vy = Math.abs(vy);
      }
      if (y > 84) {
        y = 84;
        vy = -Math.abs(vy);
      }
      const life = spark.life - dt;
      if (life <= 0) {
        api.miss();
        continue;
      }
      next.push({ ...spark, x, y, vx, vy, life });
    }
    while (next.length < 3) {
      next.push(spawn());
    }
    sparksRef.current = next;
    api.report(next.map((spark) => ({ id: spark.id, label: "spark", x: spark.x, y: spark.y, size: spark.size, isCorrect: true })));
    bump();
  }, active);
  useEffect(() => {
    api.setAdvance(() => {
      const spark = sparksRef.current[0];
      if (spark) {
        tap(spark.id);
      }
    });
  }, [api]);
  return (
    <>
      {sparksRef.current.map((spark) => {
        const opacity = spark.life < 700 ? Math.max(0.25, spark.life / 700) : 1;
        return (
          <button
            aria-label="빛나는 패치"
            className={styles.waitingGameTarget}
            data-correct="true"
            data-game-target="true"
            data-variant="spark"
            key={spark.id}
            onPointerDown={(event) => {
              event.stopPropagation();
              tap(spark.id);
            }}
            style={{
              left: `${spark.x}%`,
              top: `${spark.y}%`,
              width: spark.size,
              height: spark.size,
              opacity,
              "--waiting-game-target-color": GOLD
            } as CSSProperties}
            type="button"
          >
            <Sparkles size={Math.round(spark.size * 0.4)} />
          </button>
        );
      })}
      <div className={styles.waitingGameHint}>흐르는 빛 패치를 놓치지 말고 탭</div>
    </>
  );
}

// --- 2. 패치 폭포 (falling gold, avoid bombs) ------------------------------------
type Faller = { id: string; x: number; y: number; vy: number; size: number; bad: boolean };

function PatchFallGame({ api, active }: GameProps): ReactElement {
  const fallersRef = useRef<Faller[]>([]);
  const spawnRef = useRef(0);
  const hitsRef = useRef(0);
  const bump = useFrame();
  const spawn = () => {
    fallersRef.current.push({
      id: uid(),
      x: rand(12, 88),
      y: -6,
      vy: rand(20, 28) + Math.min(16, hitsRef.current * 0.6),
      size: rand(42, 52),
      bad: Math.random() < 0.26
    });
  };
  const tap = (id: string) => {
    const found = fallersRef.current.find((faller) => faller.id === id);
    if (!found) {
      return;
    }
    if (found.bad) {
      api.miss();
      api.flash("펑!", "bad");
    } else {
      api.hit(10);
      hitsRef.current += 1;
    }
    fallersRef.current = fallersRef.current.filter((faller) => faller.id !== id);
  };
  useRafLoop((dt) => {
    const s = dt / 1000;
    spawnRef.current += dt;
    const interval = Math.max(560, 980 - hitsRef.current * 14);
    if (spawnRef.current >= interval) {
      spawnRef.current = 0;
      spawn();
    }
    const next: Faller[] = [];
    for (const faller of fallersRef.current) {
      const y = faller.y + faller.vy * s;
      if (y > 108) {
        if (!faller.bad) {
          api.miss();
        }
        continue;
      }
      next.push({ ...faller, y });
    }
    fallersRef.current = next;
    api.report(next.map((faller) => ({ id: faller.id, label: faller.bad ? "bomb" : "gold", x: faller.x, y: faller.y, size: faller.size, isCorrect: !faller.bad })));
    bump();
  }, active);
  useEffect(() => {
    api.setAdvance(() => {
      const gold = fallersRef.current.find((faller) => !faller.bad);
      if (gold) {
        tap(gold.id);
      } else {
        spawn();
      }
    });
  }, [api]);
  return (
    <>
      {fallersRef.current.map((faller) => (
        <button
          aria-label={faller.bad ? "폭탄" : "골드 패치"}
          className={styles.waitingGameTarget}
          data-correct={faller.bad ? "false" : "true"}
          data-game-target="true"
          data-variant={faller.bad ? "bomb" : "gold"}
          key={faller.id}
          onPointerDown={(event) => {
            event.stopPropagation();
            tap(faller.id);
          }}
          style={{
            left: `${faller.x}%`,
            top: `${faller.y}%`,
            width: faller.size,
            height: faller.size,
            "--waiting-game-target-color": faller.bad ? CORAL : GOLD
          } as CSSProperties}
          type="button"
        >
          {faller.bad ? <span>✕</span> : <Sparkles size={Math.round(faller.size * 0.38)} />}
        </button>
      ))}
      <div className={styles.waitingGameHint}>골드는 탭, 빨강 폭탄은 피하기</div>
    </>
  );
}

// --- 3. 두더지 패치 (whack-a-mole) ----------------------------------------------
const WHACK_HOLES = [
  { x: 24, y: 36 },
  { x: 50, y: 32 },
  { x: 76, y: 38 },
  { x: 30, y: 70 },
  { x: 58, y: 68 },
  { x: 82, y: 72 }
];
type Mole = { up: boolean; bad: boolean; until: number };

function MoleWhackGame({ api, active }: GameProps): ReactElement {
  const molesRef = useRef<Mole[]>(WHACK_HOLES.map(() => ({ up: false, bad: false, until: 0 })));
  const clockRef = useRef(0);
  const spawnRef = useRef(0);
  const hitsRef = useRef(0);
  const bump = useFrame();
  const popOne = () => {
    const idle = molesRef.current
      .map((mole, index) => ({ mole, index }))
      .filter((entry) => !entry.mole.up);
    if (idle.length === 0) {
      return;
    }
    const { index } = pick(idle);
    molesRef.current[index] = { up: true, bad: Math.random() < 0.2, until: clockRef.current + rand(820, 1250) };
  };
  const tap = (index: number) => {
    const mole = molesRef.current[index];
    if (!mole.up) {
      return;
    }
    if (mole.bad) {
      api.miss();
      api.flash("펑!", "bad");
    } else {
      api.hit(10);
      hitsRef.current += 1;
    }
    molesRef.current[index] = { up: false, bad: false, until: 0 };
  };
  useRafLoop((dt) => {
    clockRef.current += dt;
    spawnRef.current += dt;
    const upCount = molesRef.current.filter((mole) => mole.up).length;
    const interval = Math.max(480, 780 - hitsRef.current * 12);
    if (spawnRef.current >= interval && upCount < 2) {
      spawnRef.current = 0;
      popOne();
    }
    for (let index = 0; index < molesRef.current.length; index += 1) {
      const mole = molesRef.current[index];
      if (mole.up && clockRef.current > mole.until) {
        if (!mole.bad) {
          api.miss();
        }
        molesRef.current[index] = { up: false, bad: false, until: 0 };
      }
    }
    api.report(molesRef.current.map((mole, index) => ({
      id: `hole-${index}`,
      label: mole.bad ? "bomb" : "mole",
      x: WHACK_HOLES[index].x,
      y: WHACK_HOLES[index].y,
      size: 52,
      isCorrect: mole.up && !mole.bad
    })));
    bump();
  }, active);
  useEffect(() => {
    api.setAdvance(() => {
      const index = molesRef.current.findIndex((mole) => mole.up && !mole.bad);
      if (index >= 0) {
        tap(index);
      } else {
        popOne();
      }
    });
  }, [api]);
  return (
    <>
      {WHACK_HOLES.map((hole, index) => (
        <div
          className={styles.waitingGameHole}
          key={`hole-${index}`}
          style={{ left: `${hole.x}%`, top: `${hole.y + 6}%` } as CSSProperties}
        />
      ))}
      {molesRef.current.map((mole, index) =>
        mole.up ? (
          <button
            aria-label={mole.bad ? "폭탄" : "패치"}
            className={styles.waitingGameTarget}
            data-correct={mole.bad ? "false" : "true"}
            data-game-target="true"
            data-variant="mole"
            key={`mole-${index}`}
            onPointerDown={(event) => {
              event.stopPropagation();
              tap(index);
            }}
            style={{
              left: `${WHACK_HOLES[index].x}%`,
              top: `${WHACK_HOLES[index].y}%`,
              width: 52,
              height: 52,
              "--waiting-game-target-color": mole.bad ? CORAL : GOLD
            } as CSSProperties}
            type="button"
          >
            {mole.bad ? <span>✕</span> : <Sparkles size={20} />}
          </button>
        ) : null
      )}
      <div className={styles.waitingGameHint}>튀어나온 패치를 빠르게 탭</div>
    </>
  );
}

// --- 4. 버블 팝 (rising bubbles) -------------------------------------------------
type Bubble = { id: string; x0: number; x: number; y: number; vy: number; amp: number; phase: number; size: number; gold: boolean };

function BubblePopGame({ api, active }: GameProps): ReactElement {
  const bubblesRef = useRef<Bubble[]>([]);
  const spawnRef = useRef(0);
  const bump = useFrame();
  const spawn = () => {
    const x0 = rand(14, 86);
    bubblesRef.current.push({
      id: uid(),
      x0,
      x: x0,
      y: 108,
      vy: rand(15, 24),
      amp: rand(3, 8),
      phase: rand(0, 6.28),
      size: rand(40, 56),
      gold: Math.random() < 0.18
    });
  };
  const tap = (id: string) => {
    const found = bubblesRef.current.find((bubble) => bubble.id === id);
    if (!found) {
      return;
    }
    api.hit(found.gold ? 20 : 10, found.gold ? "보너스!" : undefined);
    bubblesRef.current = bubblesRef.current.filter((bubble) => bubble.id !== id);
  };
  useRafLoop((dt) => {
    const s = dt / 1000;
    spawnRef.current += dt;
    if (spawnRef.current >= 720) {
      spawnRef.current = 0;
      spawn();
    }
    const next: Bubble[] = [];
    for (const bubble of bubblesRef.current) {
      const y = bubble.y - bubble.vy * s;
      const phase = bubble.phase + s * 2.4;
      const x = clamp(bubble.x0 + Math.sin(phase) * bubble.amp, 8, 92);
      if (y < -6) {
        api.miss();
        continue;
      }
      next.push({ ...bubble, y, x, phase });
    }
    bubblesRef.current = next;
    api.report(next.map((bubble) => ({ id: bubble.id, label: bubble.gold ? "gold" : "bubble", x: bubble.x, y: bubble.y, size: bubble.size, isCorrect: true })));
    bump();
  }, active);
  useEffect(() => {
    api.setAdvance(() => {
      const bubble = bubblesRef.current[0];
      if (bubble) {
        tap(bubble.id);
      } else {
        spawn();
      }
    });
  }, [api]);
  return (
    <>
      {bubblesRef.current.map((bubble) => (
        <button
          aria-label={bubble.gold ? "보너스 버블" : "버블"}
          className={styles.waitingGameTarget}
          data-correct="true"
          data-game-target="true"
          data-variant="bubble"
          key={bubble.id}
          onPointerDown={(event) => {
            event.stopPropagation();
            tap(bubble.id);
          }}
          style={{
            left: `${bubble.x}%`,
            top: `${bubble.y}%`,
            width: bubble.size,
            height: bubble.size,
            "--waiting-game-target-color": bubble.gold ? GOLD : TEAL
          } as CSSProperties}
          type="button"
        >
          {bubble.gold ? <Sparkles size={Math.round(bubble.size * 0.38)} /> : null}
        </button>
      ))}
      <div className={styles.waitingGameHint}>올라오는 버블을 터뜨리기 · 골드는 보너스</div>
    </>
  );
}

// --- 5. 조준 타겟 (bouncing target) ---------------------------------------------
type AimTarget = { x: number; y: number; vx: number; vy: number; size: number };

function AimBounceGame({ api, active }: GameProps): ReactElement {
  const targetRef = useRef<AimTarget>({
    x: 50,
    y: 50,
    vx: rand(22, 32) * (Math.random() < 0.5 ? 1 : -1),
    vy: rand(22, 32) * (Math.random() < 0.5 ? 1 : -1),
    size: 58
  });
  const bump = useFrame();
  const hitTarget = () => {
    const target = targetRef.current;
    api.hit(12);
    const speed = Math.min(66, Math.hypot(target.vx, target.vy) * 1.08);
    const angle = Math.random() * Math.PI * 2;
    target.vx = Math.cos(angle) * speed;
    target.vy = Math.sin(angle) * speed;
    target.size = Math.max(34, target.size - 2);
  };
  const missTap = () => {
    api.miss();
    api.flash("빗나감", "bad");
  };
  useRafLoop((dt) => {
    const s = dt / 1000;
    const target = targetRef.current;
    target.x += target.vx * s;
    target.y += target.vy * s;
    if (target.x < 8) {
      target.x = 8;
      target.vx = Math.abs(target.vx);
    }
    if (target.x > 92) {
      target.x = 92;
      target.vx = -Math.abs(target.vx);
    }
    if (target.y < 16) {
      target.y = 16;
      target.vy = Math.abs(target.vy);
    }
    if (target.y > 84) {
      target.y = 84;
      target.vy = -Math.abs(target.vy);
    }
    api.report([{ id: "aim", label: "target", x: target.x, y: target.y, size: target.size, isCorrect: true }]);
    bump();
  }, active);
  useEffect(() => {
    api.setAdvance(() => hitTarget());
  }, [api]);
  const target = targetRef.current;
  return (
    <>
      <div className={styles.waitingGameStageFill} onPointerDown={missTap} role="presentation" />
      <button
        aria-label="움직이는 타겟"
        className={styles.waitingGameTarget}
        data-correct="true"
        data-game-target="true"
        data-variant="aim"
        onPointerDown={(event) => {
          event.stopPropagation();
          hitTarget();
        }}
        style={{
          left: `${target.x}%`,
          top: `${target.y}%`,
          width: target.size,
          height: target.size,
          "--waiting-game-target-color": TEAL
        } as CSSProperties}
        type="button"
      >
        <Crosshair size={Math.round(target.size * 0.44)} />
      </button>
      <div className={styles.waitingGameHint}>튕겨 다니는 타겟을 조준해 탭</div>
    </>
  );
}

// --- 6. 컬러 매치 (match the shown color) ---------------------------------------
const MATCH_COLORS = [
  { name: "민트", color: TEAL },
  { name: "골드", color: GOLD },
  { name: "코랄", color: CORAL },
  { name: "블루", color: BLUE },
  { name: "크림", color: CREAM },
  { name: "네이비", color: NAVY }
];
type Drifter = { id: string; x: number; y: number; vx: number; vy: number; size: number; name: string; color: string; isCorrect: boolean };
type MatchRound = { target: { name: string; color: string }; chips: Drifter[] };

function makeMatchRound(): MatchRound {
  const target = pick(MATCH_COLORS);
  const others = MATCH_COLORS.filter((entry) => entry.name !== target.name)
    .sort(() => Math.random() - 0.5)
    .slice(0, 4);
  const chips = [target, ...others]
    .sort(() => Math.random() - 0.5)
    .map((entry) => ({
      id: uid(),
      x: rand(18, 82),
      y: rand(26, 78),
      vx: rand(-9, 9),
      vy: rand(-9, 9),
      size: 50,
      name: entry.name,
      color: entry.color,
      isCorrect: entry.name === target.name
    }));
  return { target: { name: target.name, color: target.color }, chips };
}

function ColorMatchGame({ api, active }: GameProps): ReactElement {
  const roundRef = useRef<MatchRound>(makeMatchRound());
  const bump = useFrame();
  const tap = (id: string) => {
    const chip = roundRef.current.chips.find((entry) => entry.id === id);
    if (!chip) {
      return;
    }
    if (chip.isCorrect) {
      api.hit(12, "정답!");
      roundRef.current = makeMatchRound();
    } else {
      api.miss();
      api.flash("땡!", "bad");
    }
  };
  useRafLoop((dt) => {
    const s = dt / 1000;
    for (const chip of roundRef.current.chips) {
      chip.x += chip.vx * s;
      chip.y += chip.vy * s;
      if (chip.x < 10) {
        chip.x = 10;
        chip.vx = Math.abs(chip.vx);
      }
      if (chip.x > 90) {
        chip.x = 90;
        chip.vx = -Math.abs(chip.vx);
      }
      if (chip.y < 20) {
        chip.y = 20;
        chip.vy = Math.abs(chip.vy);
      }
      if (chip.y > 82) {
        chip.y = 82;
        chip.vy = -Math.abs(chip.vy);
      }
    }
    api.report(roundRef.current.chips.map((chip) => ({ id: chip.id, label: chip.name, x: chip.x, y: chip.y, size: chip.size, isCorrect: chip.isCorrect })));
    bump();
  }, active);
  useEffect(() => {
    api.setAdvance(() => {
      const correct = roundRef.current.chips.find((chip) => chip.isCorrect);
      if (correct) {
        tap(correct.id);
      }
    });
  }, [api]);
  const target = roundRef.current.target;
  return (
    <>
      {roundRef.current.chips.map((chip) => (
        <button
          aria-label={chip.name}
          className={styles.waitingGameTarget}
          data-correct={chip.isCorrect ? "true" : "false"}
          data-game-target="true"
          data-variant="solid"
          key={chip.id}
          onPointerDown={(event) => {
            event.stopPropagation();
            tap(chip.id);
          }}
          style={{
            left: `${chip.x}%`,
            top: `${chip.y}%`,
            width: chip.size,
            height: chip.size,
            background: chip.color,
            "--waiting-game-target-color": chip.color
          } as CSSProperties}
          type="button"
        />
      ))}
      <div className={styles.waitingGameHint}>
        <span className={styles.waitingGameSwatch} style={{ background: target.color } as CSSProperties} />
        <strong>{target.name}</strong> 색을 찾으세요
      </div>
    </>
  );
}

// --- 7. 숫자 순서 (tap 1→5 in order) --------------------------------------------
type NumChip = { id: string; x: number; y: number; vx: number; vy: number; n: number };

function makeNumbers(): NumChip[] {
  return [1, 2, 3, 4, 5].map((n) => ({
    id: uid(),
    x: rand(16, 84),
    y: rand(26, 80),
    vx: rand(-8, 8),
    vy: rand(-8, 8),
    n
  }));
}

function NumberOrderGame({ api, active }: GameProps): ReactElement {
  const chipsRef = useRef<NumChip[]>(makeNumbers());
  const expectRef = useRef(1);
  const bump = useFrame();
  const tap = (id: string) => {
    const chip = chipsRef.current.find((entry) => entry.id === id);
    if (!chip) {
      return;
    }
    if (chip.n === expectRef.current) {
      api.hit(8);
      if (expectRef.current >= 5) {
        api.flash("완성!", "good");
        chipsRef.current = makeNumbers();
        expectRef.current = 1;
      } else {
        expectRef.current += 1;
      }
    } else {
      api.miss();
      api.flash("순서!", "bad");
      expectRef.current = 1;
    }
  };
  useRafLoop((dt) => {
    const s = dt / 1000;
    for (const chip of chipsRef.current) {
      chip.x += chip.vx * s;
      chip.y += chip.vy * s;
      if (chip.x < 10) {
        chip.x = 10;
        chip.vx = Math.abs(chip.vx);
      }
      if (chip.x > 90) {
        chip.x = 90;
        chip.vx = -Math.abs(chip.vx);
      }
      if (chip.y < 20) {
        chip.y = 20;
        chip.vy = Math.abs(chip.vy);
      }
      if (chip.y > 82) {
        chip.y = 82;
        chip.vy = -Math.abs(chip.vy);
      }
    }
    api.report(chipsRef.current.map((chip) => ({ id: chip.id, label: String(chip.n), x: chip.x, y: chip.y, size: 48, isCorrect: chip.n === expectRef.current })));
    bump();
  }, active);
  useEffect(() => {
    api.setAdvance(() => {
      const chip = chipsRef.current.find((entry) => entry.n === expectRef.current);
      if (chip) {
        tap(chip.id);
      }
    });
  }, [api]);
  const expected = expectRef.current;
  return (
    <>
      {chipsRef.current.map((chip) => {
        const isNext = chip.n === expected;
        return (
          <button
            aria-label={`숫자 ${chip.n}`}
            className={styles.waitingGameTarget}
            data-correct={isNext ? "true" : "false"}
            data-game-target="true"
            key={chip.id}
            onPointerDown={(event) => {
              event.stopPropagation();
              tap(chip.id);
            }}
            style={{
              left: `${chip.x}%`,
              top: `${chip.y}%`,
              width: isNext ? 56 : 46,
              height: isNext ? 56 : 46,
              "--waiting-game-target-color": isNext ? GOLD : CREAM
            } as CSSProperties}
            type="button"
          >
            <span>{chip.n}</span>
          </button>
        );
      })}
      <div className={styles.waitingGameHint}>
        다음 순서: <strong>{expected}</strong>
      </div>
    </>
  );
}

// --- 8. 신호 반응 (tap only on green) -------------------------------------------
type SignalState = "wait" | "stop" | "go";

function SignalTapGame({ api, active }: GameProps): ReactElement {
  const phaseRef = useRef<{ state: SignalState; until: number }>({ state: "wait", until: 900 });
  const sinceGoRef = useRef(0);
  const elapsedRef = useRef(0);
  const bump = useFrame();
  const nextPhase = () => {
    sinceGoRef.current += 1;
    let state: SignalState;
    if (sinceGoRef.current >= 2 && Math.random() < 0.7) {
      state = "go";
    } else {
      state = Math.random() < 0.5 ? "wait" : "stop";
    }
    if (state === "go") {
      sinceGoRef.current = 0;
      phaseRef.current = { state, until: rand(680, 1050) };
    } else {
      phaseRef.current = { state, until: rand(650, 1300) };
    }
    elapsedRef.current = 0;
  };
  const tap = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (phaseRef.current.state === "go") {
      api.hit(14, "반응!");
    } else {
      api.miss();
      api.flash("성급!", "bad");
    }
    nextPhase();
  };
  useRafLoop((dt) => {
    elapsedRef.current += dt;
    if (elapsedRef.current >= phaseRef.current.until) {
      if (phaseRef.current.state === "go") {
        api.miss();
        api.flash("놓침", "bad");
      }
      nextPhase();
    }
    api.report([{ id: "signal", label: phaseRef.current.state, x: 50, y: 52, size: 130, isCorrect: phaseRef.current.state === "go" }]);
    bump();
  }, active);
  useEffect(() => {
    api.setAdvance(() => {
      phaseRef.current = { state: "go", until: rand(700, 1000) };
      elapsedRef.current = 0;
      sinceGoRef.current = 0;
    });
  }, [api]);
  const state = phaseRef.current.state;
  const label = state === "go" ? "지금!" : state === "stop" ? "멈춰" : "준비";
  return (
    <div className={styles.waitingGameStageCenter}>
      <button
        aria-label={`신호 ${label}`}
        className={styles.waitingGameSignal}
        data-game-target="true"
        data-state={state}
        onPointerDown={tap}
        type="button"
      >
        <span>{label}</span>
      </button>
      <div className={styles.waitingGameHint}>초록 &quot;지금!&quot;에만 누르세요</div>
    </div>
  );
}

// --- 9. 리듬 탭 (timing ring) ---------------------------------------------------
function RhythmTapGame({ api, active }: GameProps): ReactElement {
  const tRef = useRef(0);
  const durRef = useRef(1300);
  const bump = useFrame();
  const reset = (faster: boolean) => {
    tRef.current = 0;
    if (faster) {
      durRef.current = Math.max(820, durRef.current - 45);
    }
  };
  const judge = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const ratio = tRef.current / durRef.current;
    if (ratio >= 0.9 && ratio <= 1.08) {
      api.hit(20, "Perfect!");
      reset(true);
    } else if (ratio >= 0.72 && ratio < 0.9) {
      api.hit(10, "Good");
      reset(true);
    } else {
      api.miss();
      api.flash(ratio < 0.72 ? "너무 빨라요" : "놓침", "bad");
      reset(false);
    }
  };
  useRafLoop((dt) => {
    tRef.current += dt;
    if (tRef.current >= durRef.current + 140) {
      api.miss();
      api.flash("놓침", "bad");
      tRef.current = 0;
    }
    const ratio = Math.min(1.2, tRef.current / durRef.current);
    api.report([{ id: "ring", label: "ring", x: 50, y: 50, size: Math.round(64 + (1 - Math.min(1, ratio)) * 128), isCorrect: ratio > 0.8 && ratio < 1.08 }]);
    bump();
  }, active);
  useEffect(() => {
    api.setAdvance(() => {
      tRef.current = durRef.current * 0.96;
    });
  }, [api]);
  const ratio = Math.min(1, tRef.current / durRef.current);
  const outer = 66 + (1 - ratio) * 128;
  const good = ratio > 0.72;
  return (
    <div className={styles.waitingGameStageFill} onPointerDown={judge} role="presentation">
      <div className={styles.waitingGameRingWrap}>
        <div className={styles.waitingGameRingCore} />
        <div
          className={styles.waitingGameRing}
          data-good={good ? "true" : "false"}
          style={{ width: outer, height: outer } as CSSProperties}
        />
      </div>
      <div className={styles.waitingGameHint}>링이 중앙과 겹칠 때 탭</div>
    </div>
  );
}

// --- 10. 기억 순서 (Simon) ------------------------------------------------------
const MEMORY_PADS = [TEAL, GOLD, CORAL, BLUE];

function MemoryEchoGame({ api, active }: GameProps): ReactElement {
  const seqRef = useRef<number[]>([]);
  const phaseRef = useRef<"watch" | "input">("watch");
  const inputPosRef = useRef(0);
  const elapsedRef = useRef(0);
  const litRef = useRef(-1);
  const tapLitRef = useRef<{ index: number; until: number }>({ index: -1, until: 0 });
  const bump = useFrame();
  if (seqRef.current.length === 0) {
    seqRef.current = [randInt(0, 3), randInt(0, 3)];
  }
  const startRound = (grow: boolean) => {
    if (grow) {
      seqRef.current = [...seqRef.current, randInt(0, 3)];
    }
    phaseRef.current = "watch";
    inputPosRef.current = 0;
    elapsedRef.current = 0;
    litRef.current = -1;
  };
  const tapPad = (index: number) => {
    if (phaseRef.current !== "input") {
      return;
    }
    tapLitRef.current = { index, until: 220 };
    if (index === seqRef.current[inputPosRef.current]) {
      inputPosRef.current += 1;
      if (inputPosRef.current >= seqRef.current.length) {
        api.hit(15, "기억 성공!");
        startRound(true);
      }
    } else {
      api.miss();
      api.flash("틀렸어요", "bad");
      seqRef.current = [randInt(0, 3), randInt(0, 3)];
      startRound(false);
    }
  };
  useRafLoop((dt) => {
    if (phaseRef.current === "watch") {
      elapsedRef.current += dt;
      const step = 640;
      const index = Math.floor(elapsedRef.current / step);
      if (index >= seqRef.current.length) {
        phaseRef.current = "input";
        inputPosRef.current = 0;
        litRef.current = -1;
      } else {
        const within = elapsedRef.current - index * step;
        litRef.current = within < 420 ? seqRef.current[index] : -1;
      }
    }
    if (tapLitRef.current.index >= 0) {
      tapLitRef.current.until -= dt;
      if (tapLitRef.current.until <= 0) {
        tapLitRef.current = { index: -1, until: 0 };
      }
    }
    api.report(MEMORY_PADS.map((_, index) => ({
      id: `pad-${index}`,
      label: `pad-${index}`,
      x: index % 2 === 0 ? 38 : 62,
      y: index < 2 ? 40 : 64,
      size: 64,
      isCorrect: phaseRef.current === "input" && index === seqRef.current[inputPosRef.current]
    })));
    bump();
  }, active);
  useEffect(() => {
    api.setAdvance(() => {
      if (phaseRef.current === "input") {
        tapPad(seqRef.current[inputPosRef.current]);
      } else {
        phaseRef.current = "input";
        inputPosRef.current = 0;
        litRef.current = -1;
      }
    });
  }, [api]);
  const litPad = litRef.current;
  const phase = phaseRef.current;
  return (
    <>
      <div className={styles.waitingGameGrid} data-phase={phase}>
        {MEMORY_PADS.map((color, index) => {
          const on = litPad === index || tapLitRef.current.index === index;
          return (
            <button
              aria-label={`패치 ${index + 1}`}
              className={styles.waitingGamePad}
              data-game-target="true"
              data-lit={on ? "true" : "false"}
              key={`pad-${index}`}
              onPointerDown={(event) => {
                event.stopPropagation();
                tapPad(index);
              }}
              style={{ "--pad-color": color } as CSSProperties}
              type="button"
            />
          );
        })}
      </div>
      <div className={styles.waitingGameHint}>
        {phase === "watch" ? "순서를 기억하세요" : `따라 누르기 ${inputPosRef.current}/${seqRef.current.length}`}
      </div>
    </>
  );
}

type GameEntry = {
  kind: string;
  title: string;
  instruction: string;
  badge: string;
  Component: (props: GameProps) => ReactElement;
};

const GAME_ENTRIES: GameEntry[] = [
  { kind: "sparkDrift", title: "빛나는 패치 잡기", instruction: "흐르며 사라지는 빛 패치를 놓치지 말고 누르세요.", badge: "반응", Component: SparkDriftGame },
  { kind: "patchFall", title: "패치 폭포", instruction: "떨어지는 골드 패치는 누르고 빨강 폭탄은 피하세요.", badge: "집중", Component: PatchFallGame },
  { kind: "moleWhack", title: "두더지 패치", instruction: "구멍에서 튀어나온 패치를 빠르게 누르세요.", badge: "순발력", Component: MoleWhackGame },
  { kind: "bubblePop", title: "버블 팝", instruction: "위로 올라가는 버블을 터뜨리세요. 골드는 보너스!", badge: "터치", Component: BubblePopGame },
  { kind: "aimBounce", title: "조준 타겟", instruction: "튕겨 다니는 타겟을 정확히 조준해 누르세요.", badge: "조준", Component: AimBounceGame },
  { kind: "colorMatch", title: "컬러 매치", instruction: "제시된 색과 같은 패치만 골라 누르세요.", badge: "판단", Component: ColorMatchGame },
  { kind: "numberOrder", title: "숫자 순서", instruction: "떠다니는 숫자를 1부터 순서대로 누르세요.", badge: "순서", Component: NumberOrderGame },
  { kind: "signalTap", title: "신호 반응", instruction: "초록 신호에만 누르고 빨강 신호는 참으세요.", badge: "반응속도", Component: SignalTapGame },
  { kind: "rhythmTap", title: "리듬 탭", instruction: "줄어드는 링이 중앙과 겹치는 순간 누르세요.", badge: "타이밍", Component: RhythmTapGame },
  { kind: "memoryEcho", title: "기억 순서", instruction: "반짝이는 순서를 기억했다가 그대로 누르세요.", badge: "기억력", Component: MemoryEchoGame }
];

export function WaitingMiniGame({ progress }: { progress: number }) {
  const [gameIndex, setGameIndex] = useState(() => Math.floor(Math.random() * GAME_ENTRIES.length));
  const [gameToken, setGameToken] = useState(0);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [misses, setMisses] = useState(0);
  const [toast, setToast] = useState<{ text: string; tone: Tone; token: number } | null>(null);
  const comboRef = useRef(0);
  const toastTokenRef = useRef(0);
  const advanceRef = useRef<(() => void) | null>(null);
  const snapshotRef = useRef<{ game: string; instruction: string; score: number; combo: number; misses: number; targets: SnapshotTarget[] }>({
    game: "",
    instruction: "",
    score: 0,
    combo: 0,
    misses: 0,
    targets: []
  });

  const entry = GAME_ENTRIES[gameIndex] ?? GAME_ENTRIES[0];

  const hit = useCallback((points: number, label?: string) => {
    const awarded = points + Math.min(24, comboRef.current * 2);
    comboRef.current += 1;
    setCombo(comboRef.current);
    setScore((value) => value + awarded);
    toastTokenRef.current += 1;
    setToast({ text: label ?? `+${awarded}`, tone: "good", token: toastTokenRef.current });
  }, []);
  const miss = useCallback(() => {
    comboRef.current = 0;
    setCombo(0);
    setMisses((value) => value + 1);
  }, []);
  const flash = useCallback((text: string, tone: Tone) => {
    toastTokenRef.current += 1;
    setToast({ text, tone, token: toastTokenRef.current });
  }, []);
  const report = useCallback((targets: SnapshotTarget[]) => {
    snapshotRef.current.targets = targets;
  }, []);
  const setAdvance = useCallback((fn: () => void) => {
    advanceRef.current = fn;
  }, []);
  const api = useMemo<GameApi>(() => ({ hit, miss, flash, report, setAdvance }), [hit, miss, flash, report, setAdvance]);

  useEffect(() => {
    if (!toast) {
      return undefined;
    }
    const timer = window.setTimeout(() => setToast(null), 720);
    return () => window.clearTimeout(timer);
  }, [toast?.token]);

  useEffect(() => {
    snapshotRef.current = { ...snapshotRef.current, game: entry.title, instruction: entry.instruction, score, combo, misses };
  }, [entry.title, entry.instruction, score, combo, misses]);

  useEffect(() => {
    const browserWindow = window as Window & {
      render_game_to_text?: () => string;
      advanceTime?: (ms?: number) => void;
    };
    const previousRender = browserWindow.render_game_to_text;
    const previousAdvance = browserWindow.advanceTime;
    browserWindow.render_game_to_text = () =>
      JSON.stringify({
        mode: "waiting-mini-game",
        coordinateSystem: "origin top-left, x/y are percentages inside the game board",
        ...snapshotRef.current
      });
    browserWindow.advanceTime = () => advanceRef.current?.();
    return () => {
      browserWindow.render_game_to_text = previousRender;
      browserWindow.advanceTime = previousAdvance;
    };
  }, []);

  const shuffle = () => {
    setGameIndex((previous) => {
      if (GAME_ENTRIES.length <= 1) {
        return previous;
      }
      let next = previous;
      while (next === previous) {
        next = Math.floor(Math.random() * GAME_ENTRIES.length);
      }
      return next;
    });
    setGameToken((value) => value + 1);
    comboRef.current = 0;
    setCombo(0);
    setScore(0);
    setMisses(0);
    setToast(null);
    advanceRef.current = null;
    snapshotRef.current.targets = [];
  };

  const ActiveGame = entry.Component;

  return (
    <div
      className={styles.waitingGame}
      data-game-kind={entry.kind}
      style={{ "--waiting-game-progress": `${progress}%` } as CSSProperties}
    >
      <div className={styles.waitingGameHud}>
        <span>점수 {score}</span>
        <span>콤보 {combo}</span>
        <span>실수 {misses}</span>
      </div>
      <div className={styles.waitingGameTitleRow}>
        <div>
          <strong>{entry.title}</strong>
          <p>{entry.instruction}</p>
        </div>
        <div className={styles.waitingGameHeadSide}>
          <span>{entry.badge}</span>
          <button
            aria-label="다른 게임으로 바꾸기"
            className={styles.waitingGameShuffle}
            onClick={shuffle}
            type="button"
          >
            <Shuffle size={13} /> 다른 게임
          </button>
        </div>
      </div>
      <div className={styles.waitingGameBoard}>
        <div className={styles.waitingGameProgressGlow} />
        <div className={styles.waitingGameStage} key={gameToken}>
          <ActiveGame active api={api} />
        </div>
        {toast ? (
          <div className={styles.waitingGameToast} data-tone={toast.tone} key={toast.token}>
            {toast.text}
          </div>
        ) : null}
      </div>
    </div>
  );
}
