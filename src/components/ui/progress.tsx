"use client"

import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "@/lib/utils"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "bg-[#E5E2DC] relative h-1.5 w-full overflow-hidden rounded-full",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 rounded-full transition-all duration-500 ease-out"
        style={{
          transform: `translateX(-${100 - (value || 0)}%)`,
          backgroundColor: 'var(--progress-indicator, #C67A52)',
        }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
