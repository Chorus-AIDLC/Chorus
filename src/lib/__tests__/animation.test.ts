import { describe, it, expect } from "vitest";
import {
  ANIM,
  fadeInUp,
  fadeIn,
  scaleIn,
  staggerContainer,
  staggerItem,
  dropdownVariants,
} from "../animation";

describe("ANIM constants", () => {
  it("has duration values in ascending order", () => {
    expect(ANIM.fast).toBeLessThan(ANIM.normal);
    expect(ANIM.normal).toBeLessThan(ANIM.slow);
  });

  it("has positive duration values", () => {
    expect(ANIM.fast).toBeGreaterThan(0);
    expect(ANIM.normal).toBeGreaterThan(0);
    expect(ANIM.slow).toBeGreaterThan(0);
  });

  it("has easing curves with 4 control points", () => {
    expect(ANIM.easeOut).toHaveLength(4);
    expect(ANIM.easeInOut).toHaveLength(4);
  });

  it("has positive stagger delays", () => {
    expect(ANIM.stagger).toBeGreaterThan(0);
    expect(ANIM.staggerFast).toBeGreaterThan(0);
    expect(ANIM.staggerFast).toBeLessThanOrEqual(ANIM.stagger);
  });

  it("has spring transition preset", () => {
    expect(ANIM.spring).toEqual({
      type: "spring",
      stiffness: 500,
      damping: 30,
    });
  });

  it("has tween transition preset", () => {
    expect(ANIM.tween.type).toBe("tween");
    expect(ANIM.tween.duration).toBe(ANIM.normal);
  });
});

describe("variant definitions", () => {
  const allVariants = [
    { name: "fadeInUp", variant: fadeInUp },
    { name: "fadeIn", variant: fadeIn },
    { name: "scaleIn", variant: scaleIn },
    { name: "dropdownVariants", variant: dropdownVariants },
  ];

  it.each(allVariants)(
    "$name has initial, animate, and exit states",
    ({ variant }) => {
      expect(variant).toHaveProperty("initial");
      expect(variant).toHaveProperty("animate");
      expect(variant).toHaveProperty("exit");
    }
  );

  it.each(allVariants)(
    "$name starts with opacity 0 and ends with opacity 1",
    ({ variant }) => {
      const initial = variant.initial as Record<string, unknown>;
      const animate = variant.animate as Record<string, unknown>;
      expect(initial.opacity).toBe(0);
      expect(animate.opacity).toBe(1);
    }
  );

  it("fadeInUp uses y-axis translation", () => {
    const initial = fadeInUp.initial as Record<string, unknown>;
    const animate = fadeInUp.animate as Record<string, unknown>;
    expect(initial.y).toBe(8);
    expect(animate.y).toBe(0);
  });

  it("scaleIn uses scale transformation", () => {
    const initial = scaleIn.initial as Record<string, unknown>;
    const animate = scaleIn.animate as Record<string, unknown>;
    expect(initial.scale).toBe(0.95);
    expect(animate.scale).toBe(1);
  });

  it("dropdownVariants combines scale and y offset", () => {
    const initial = dropdownVariants.initial as Record<string, unknown>;
    expect(initial.scale).toBe(0.95);
    expect(initial.y).toBe(-4);
  });
});

describe("stagger variants", () => {
  it("staggerContainer uses ANIM.stagger delay", () => {
    const animate = staggerContainer.animate as Record<string, unknown>;
    const transition = animate.transition as Record<string, unknown>;
    expect(transition.staggerChildren).toBe(ANIM.stagger);
  });

  it("staggerItem starts hidden and slides up", () => {
    const initial = staggerItem.initial as Record<string, unknown>;
    const animate = staggerItem.animate as Record<string, unknown>;
    expect(initial.opacity).toBe(0);
    expect(initial.y).toBe(8);
    expect(animate.opacity).toBe(1);
    expect(animate.y).toBe(0);
  });
});
