import { cn } from "@/lib/utils";

interface ProgressRingProps {
  /** Completed count. */
  done: number;
  /** Total count. Ring renders empty (but present) when 0. */
  total: number;
  /** Outer diameter in px. */
  size?: number;
  /** Stroke width in px. */
  stroke?: number;
  /** Extra classes on the wrapping svg. */
  className?: string;
  /** Accent color for the completed arc (defaults to the theme terracotta). */
  color?: string;
  /** Track color for the remaining arc. */
  trackColor?: string;
}

/**
 * A compact Linear-style progress ring: a circular track with a completed arc
 * that fills clockwise from 12 o'clock. Used to show a theme idea's child
 * completion (done/total) at a glance. Purely presentational + accessible
 * (role=img with an x/y label); the numeric "x/y" text lives next to it in the
 * consuming component, not inside the ring.
 */
export function ProgressRing({
  done,
  total,
  size = 14,
  stroke = 2,
  className,
  color = "#B26B3D",
  trackColor = "#EAD9C8",
}: ProgressRingProps) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const dashOffset = circumference * (1 - fraction);
  const complete = total > 0 && done >= total;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn("shrink-0", className)}
      role="img"
      aria-label={`${done}/${total}`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={trackColor}
        strokeWidth={stroke}
      />
      {fraction > 0 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={complete ? "#1D9E75" : color}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          // Start the arc at 12 o'clock and fill clockwise.
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </svg>
  );
}
