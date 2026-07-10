"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ style, ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme()

  return (
    <Sonner
      // Resolved concrete theme, never "system": next-themes drives the theme via
      // a `.dark` class on <html>, so passing "system" would make sonner read the OS
      // media query instead (same trap as ReactFlow's colorMode — see CLAUDE.md).
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      className="toaster group"
      {...props}
      // Lock the toast surface to Chorus design tokens via inline CSS variables.
      // sonner ships `[data-sonner-toaster][data-sonner-theme='light'|'dark']` rules
      // (specificity 0,2,0) that hardcode --normal-bg to #fff / #000 and outrank any
      // plain stylesheet override; an inline style has the highest specificity and
      // wins, so the warm --color-card surface applies in both themes. Title,
      // description, close- and action-button colors are token-driven in globals.css.
      // A caller-supplied `style` is spread first so it composes, but the token lock
      // is written after it and therefore cannot be clobbered.
      style={
        {
          ...style,
          "--normal-bg": "var(--color-card)",
          "--normal-text": "var(--color-foreground)",
          "--normal-border": "var(--color-border)",
        } as React.CSSProperties
      }
    />
  )
}

export { Toaster }
