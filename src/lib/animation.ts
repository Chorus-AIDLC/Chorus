import type { Variants, Transition } from "framer-motion";

// Shared animation constants for Chorus UI
// Style: fast & snappy (150-200ms), suitable for productivity tools

export const ANIM = {
  // Durations (seconds)
  fast: 0.15,
  normal: 0.2,
  slow: 0.3,

  // Easing curves
  easeOut: [0, 0, 0.2, 1] as const,
  easeInOut: [0.4, 0, 0.2, 1] as const,

  // Stagger delay between list items (seconds)
  stagger: 0.04,
  staggerFast: 0.03,

  // Common transition presets
  spring: { type: "spring", stiffness: 500, damping: 30 } satisfies Transition,
  tween: { type: "tween", duration: 0.2, ease: [0, 0, 0.2, 1] } satisfies Transition,
} as const;

// --- Reusable Variants ---

export const fadeInUp: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: ANIM.normal, ease: ANIM.easeOut } },
  exit: { opacity: 0, y: -4, transition: { duration: ANIM.fast, ease: ANIM.easeOut } },
};

export const fadeIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: ANIM.normal, ease: ANIM.easeOut } },
  exit: { opacity: 0, transition: { duration: ANIM.fast, ease: ANIM.easeOut } },
};

export const scaleIn: Variants = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1, transition: { duration: ANIM.normal, ease: ANIM.easeOut } },
  exit: { opacity: 0, scale: 0.95, transition: { duration: ANIM.fast, ease: ANIM.easeOut } },
};

// Parent variant for stagger children
export const staggerContainer: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: ANIM.stagger,
    },
  },
};

// Child variant used inside stagger container
export const staggerItem: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: ANIM.normal, ease: ANIM.easeOut } },
};

// Dropdown / popover scale from top
export const dropdownVariants: Variants = {
  initial: { opacity: 0, scale: 0.95, y: -4 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { duration: ANIM.fast, ease: ANIM.easeOut } },
  exit: { opacity: 0, scale: 0.95, y: -4, transition: { duration: ANIM.fast, ease: ANIM.easeOut } },
};
